"""Estimated monthly AWS infrastructure cost for the Circuit Center production stack.

THIS IS A PRICING-BASED ESTIMATE, NOT THE ACTUAL INVOICED BILL. It multiplies
published AWS on-demand list prices by the expected monthly usage of the
resources we know we run (see `deploy.sh` / `docker-compose.prod.yml`: one
t3.small EC2 instance, its root EBS volume, and one Elastic IP). It does NOT
account for taxes, credits, Savings Plans / Reserved Instances, account-level
Free Tier offsets, EBS snapshots or AMIs, Route 53 hosted zones, CloudWatch, or
anything provisioned outside the documented stack. Treat it as a stable planning
number for the admin Expenses graph, not as accounting. For true actuals, wire
up AWS Cost Explorer -- see the TODO at the bottom of this module.

Rates below were pulled from the AWS Price List API on 2026-07-30 for
us-east-1 / "US East (N. Virginia)" (AmazonEC2 price list version
20260728175247; AWSDataTransfer version 20260720184645). Re-check them roughly
once a year, or whenever the instance type / volume size changes.
"""

from decimal import ROUND_HALF_UP, Decimal
from typing import NamedTuple

# --- Billing period ---------------------------------------------------------
# AWS bills per hour of actual runtime. 730 hrs is the conventional "average
# month" (8760 hrs / 12) used by the AWS Pricing Calculator.
HOURS_PER_MONTH = Decimal("730")

# --- EC2 compute ------------------------------------------------------------
# t3.small, Linux, Shared tenancy, on-demand, us-east-1.
# AmazonEC2 SKU QA3NBPZEQKZ2K9AR: "$0.0208 per On Demand Linux t3.small
# Instance Hour". 2 vCPU / 2 GiB.
EC2_INSTANCE_TYPE = "t3.small"
EC2_HOURLY_USD = Decimal("0.0208")

# --- EBS storage ------------------------------------------------------------
# gp3 root volume. AmazonEC2 SKU JG3KUJMBRGHV3N8G: "$0.08 per GB-month of
# General Purpose (gp3) provisioned storage - US East (N. Virginia)".
# gp3 includes 3,000 IOPS and 125 MB/s baseline at no extra charge, and we do
# not provision beyond that, so there is no additional IOPS/throughput line.
EBS_VOLUME_GB = Decimal("30")
EBS_GP3_USD_PER_GB_MONTH = Decimal("0.08")

# --- Public IPv4 (the Elastic IP) -------------------------------------------
# NOTE: an attached Elastic IP is NO LONGER FREE. Effective 2024-02-01 AWS
# charges $0.005/hr for EVERY public IPv4 address "whether attached to a
# service or not", explicitly including in-use Elastic IPs.
# Source: https://aws.amazon.com/blogs/aws/new-aws-public-ipv4-address-charge-public-ip-insights/
# (The 12-month EC2 Free Tier covers 750 hrs/mo of this; our account is well
# past 12 months, so we assume it is billed.)
PUBLIC_IPV4_COUNT = Decimal("1")
PUBLIC_IPV4_HOURLY_USD = Decimal("0.005")

# --- Data transfer out ------------------------------------------------------
# AWSDataTransfer SKU HQEH3ZWJVT46JHRG: "$0.090 per GB - first 10 TB / month
# data transfer out beyond the global free tier" (us-east-1 -> External).
# Every AWS account gets 100 GB/mo of data transfer out to the internet free,
# aggregated across all services and regions (effective 2021-12-01):
# https://aws.amazon.com/blogs/aws/aws-free-tier-data-transfer-expansion-100-gb-from-regions-and-1-tb-from-amazon-cloudfront-per-month/
# circuitcenter.ai is a low-traffic directory site serving gzipped assets and
# ~25 KB API responses, so ~50 GB/mo is a generous estimate -- comfortably
# inside the free allowance, hence $0.00 billable. Raise DATA_TRANSFER_OUT_GB
# if traffic grows; the first billable GB costs $0.09.
DATA_TRANSFER_OUT_GB = Decimal("50")
DATA_TRANSFER_FREE_TIER_GB = Decimal("100")
DATA_TRANSFER_USD_PER_GB = Decimal("0.09")

_CENTS = Decimal("0.01")


def _usd(value: Decimal) -> Decimal:
    """Round a raw computed amount to whole cents (half-up, like a bill)."""
    return value.quantize(_CENTS, rounding=ROUND_HALF_UP)


class CostLine(NamedTuple):
    """One line item of the estimate, ready to plot or tabulate."""

    key: str
    label: str
    amount: Decimal
    detail: str


def estimate_monthly_aws_cost_breakdown() -> list[CostLine]:
    """Itemized monthly estimate. Line amounts are rounded to cents and sum
    exactly to `estimate_monthly_aws_cost()`."""
    ec2 = _usd(EC2_HOURLY_USD * HOURS_PER_MONTH)
    ebs = _usd(EBS_GP3_USD_PER_GB_MONTH * EBS_VOLUME_GB)
    ipv4 = _usd(PUBLIC_IPV4_HOURLY_USD * PUBLIC_IPV4_COUNT * HOURS_PER_MONTH)

    billable_gb = max(Decimal("0"), DATA_TRANSFER_OUT_GB - DATA_TRANSFER_FREE_TIER_GB)
    dto = _usd(billable_gb * DATA_TRANSFER_USD_PER_GB)

    return [
        CostLine(
            key="ec2_compute",
            label="EC2 compute",
            amount=ec2,
            detail=f"{EC2_INSTANCE_TYPE} on-demand Linux, {HOURS_PER_MONTH:.0f} hrs "
            f"@ ${EC2_HOURLY_USD}/hr",
        ),
        CostLine(
            key="ebs_storage",
            label="EBS storage",
            amount=ebs,
            detail=f"{EBS_VOLUME_GB:.0f} GB gp3 @ ${EBS_GP3_USD_PER_GB_MONTH}/GB-mo "
            f"(3,000 IOPS + 125 MB/s baseline included)",
        ),
        CostLine(
            key="public_ipv4",
            label="Elastic IP (public IPv4)",
            amount=ipv4,
            detail=f"{PUBLIC_IPV4_COUNT:.0f} address, {HOURS_PER_MONTH:.0f} hrs "
            f"@ ${PUBLIC_IPV4_HOURLY_USD}/hr -- billed even while attached since 2024-02-01",
        ),
        CostLine(
            key="data_transfer_out",
            label="Data transfer out",
            amount=dto,
            detail=f"~{DATA_TRANSFER_OUT_GB:.0f} GB/mo, first "
            f"{DATA_TRANSFER_FREE_TIER_GB:.0f} GB free "
            f"({billable_gb:.0f} GB billable @ ${DATA_TRANSFER_USD_PER_GB}/GB)",
        ),
    ]


def estimate_monthly_aws_cost() -> Decimal:
    """Return the all-in estimated monthly AWS cost in USD as a `Decimal`.

    Pricing-based estimate for the production stack (single t3.small EC2 +
    30 GB gp3 + 1 Elastic IP + modest egress) in us-east-1. See the module
    docstring for the caveats and the sourced rates.

    As of the 2026-07-30 rate pull this returns Decimal("21.23").
    """
    return sum(
        (line.amount for line in estimate_monthly_aws_cost_breakdown()),
        Decimal("0.00"),
    )


# ---------------------------------------------------------------------------
# TODO: replace this estimate with real actuals via AWS Cost Explorer.
#
# The numbers above are list-price arithmetic. To show what we were actually
# invoiced, query Cost Explorer instead and fall back to the estimate on any
# failure so the Expenses graph never breaks:
#
#     import boto3  # add `boto3` to api/pyproject.toml dependencies
#
#     def fetch_actual_monthly_aws_cost(start: date, end: date) -> Decimal | None:
#         ce = boto3.client("ce", region_name="us-east-1")  # CE endpoint is us-east-1 only
#         resp = ce.get_cost_and_usage(
#             TimePeriod={"Start": start.isoformat(), "End": end.isoformat()},
#             Granularity="MONTHLY",
#             Metrics=["UnblendedCost"],          # or "NetAmortizedCost" post-credits
#             GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}],
#         )
#         total = sum(
#             Decimal(g["Metrics"]["UnblendedCost"]["Amount"])
#             for r in resp["ResultsByTime"] for g in r["Groups"]
#         )
#         return total.quantize(Decimal("0.01"))
#
# Blockers to resolve before enabling it:
#   1. CREDENTIALS. The api container currently has NO AWS credentials mounted
#      (nothing in docker-compose.prod.yml provides them, and the instance
#      profile on i-0d456bd12719e2176 is not known to grant billing access).
#      Prefer attaching an EC2 instance role over baking keys into .env so
#      boto3 picks them up from IMDS automatically.
#   2. IAM. The role needs `ce:GetCostAndUsage` (and `ce:GetCostForecast` if we
#      forecast). This is an account-level billing permission -- in an AWS
#      Organization it must be granted from the management account, and
#      "IAM user/role access to Billing" must be enabled in account settings.
#   3. COST. Each Cost Explorer API request costs $0.01. Do NOT call it per
#      page load -- cache the result (DB table or a daily refresh) and serve
#      the cached value. CE data also lags real usage by up to ~24h.
#   4. LATENCY / FAILURE. Wrap in try/except (botocore ClientError, no creds,
#      timeouts) and fall back to `estimate_monthly_aws_cost()`, flagging the
#      response so the UI can label the figure "estimated" vs "actual".
# ---------------------------------------------------------------------------
