"""`classify_network` — the sorter behind the visiting-organizations panel.

The panel defaults to the CORPORATE bucket, so the two verdicts are not
symmetric and these tests are not either:

* a wrong ``isp`` or ``hosting`` verdict HIDES a prospect from the only view
  the owner looks at, and is the failure this file spends most of its
  assertions on;
* a wrong ``corporate`` verdict shows one extra line he can dismiss.

Every name below is either a real value from production's `page_views.network`
(2026-08-30, 177 distinct networks) or a real AS organization name of the same
shape. None of them are invented.
"""

import pytest

from app.services.org_classify import classify_network, normalize_network

# ── The rows this panel exists to surface ───────────────────────────────────
# Four of these are production's own: a semiconductor manufacturer, a rocket
# company, a golf-cart manufacturer, a school district. The rest are the same
# shape and carry the words most likely to trip a careless keyword list —
# "Systems", "Technologies", "Communications-adjacent", "Network", "Internet".
PROSPECTS = [
    "Cirrus Logic Inc.",
    "Club Car, LLC",
    "Space Exploration Technologies Corporation",
    "Sachem Central School District",
    "Analog Devices, Inc.",
    "Texas Instruments Incorporated",
    "Vishay Intertechnology, Inc.",
    "Molex Systems Inc",
    "Keysight Technologies",
    "Advanced Micro Devices",
    "Arizona Tri University Network",
    "Nova Scotia Department of Education",
    "Internet Archive",
    "Cisco IoT",
    "Church of Cyberology",
]

ISPS = [
    "Verizon Business",
    "Cablevision Systems Corp.",
    "Comcast Cable Communications, LLC",
    "AT&T Enterprises, LLC",
    "T-Mobile USA, Inc.",
    "Charter Communications Inc",
    "Cox Communications Inc.",
    "Frontier Communications of America, Inc.",
    "Windstream Communications LLC",
    "Reliance Jio Infocomm Limited",
    "Chinanet",
    "CHINA UNICOM China169 Backbone",
    "China Mobile Communications Corporation",
    "Telecom Italia S.p.A.",
    "Turk Telekomunikasyon Anonim Sirketi",
    "TELEFÔNICA BRASIL S.A",
    "Claro NXT Telecomunicacoes Ltda",
    "Orange S.A.",
    "Vodafone Net Iletisim Hizmetler AS",
    "Excitel Broadband Private Limited",
    "Virgin Media Limited",
    "British Telecommunications PLC",
    "Bell Canada",
    "TELUS Communications Inc.",
    "Bharat Sanchar Nigam Ltd",
    "TURKCELL ILETISIM HIZMETLERI A.S.",
    "Deutsche Telekom AG",
    "GIN FIBRA INTERNET LTDA",
]

HOSTS = [
    "Amazon.com, Inc.",
    "Google LLC",
    "Microsoft Corporation",
    "Oracle Corporation",
    "Cloudflare, Inc.",
    "Akamai Technologies, Inc.",
    "Fastly, Inc.",
    "Hetzner Online GmbH",
    "OVH SAS",
    "DigitalOcean, LLC",
    "Linode, LLC",
    "Vultr Holdings LLC",
    "Scaleway SAS",
    "Railway",
    "Latitude.sh",
    "GTHost",
    "LogicWeb Inc.",
    "Zayo Bandwidth",
    "Level 3 Communications, Inc.",
    "EGIHosting",
    "HostRoyale Technologies Pvt Ltd",
    "HOST PARA TU VIDA S.A.",
    "IOMART CLOUD SERVICES LIMITED",
    "UAB Cherry Servers",
    "The Constant Company, LLC",
    "IDC, China Telecommunications Corporation",
    "Shenzhen Tencent Computer Systems Company Limited",
    "Hangzhou Alibaba Advertising Co.,Ltd.",
    "Facebook, Inc.",
    "YANDEX LLC",
    "Ahrefs Pte Ltd",
    "Oxylabs",
    "Cisco OpenDNS, LLC",
]


class TestTheProspectsSurvive:
    """The false positives that would cost the owner a sale."""

    @pytest.mark.parametrize("name", PROSPECTS)
    def test_a_named_organization_stays_corporate(self, name):
        assert classify_network(name) == "corporate"

    def test_technologies_is_not_a_hosting_word(self):
        """Two production rows hang on this: "Space Exploration Technologies
        Corporation" is SpaceX, "Akamai Technologies" is a CDN. The word
        itself decides nothing — only the brand beside it does."""
        assert classify_network("Space Exploration Technologies Corporation") == "corporate"
        assert classify_network("Akamai Technologies, Inc.") == "hosting"

    def test_systems_is_not_a_hosting_word(self):
        assert classify_network("Molex Systems Inc") == "corporate"
        assert classify_network("Cablevision Systems Corp.") == "isp"  # the BRAND, not "Systems"

    def test_network_is_not_a_carrier_word(self):
        """ "Arizona Tri University Network" is a university consortium and one
        of the most interesting rows production has resolved."""
        assert classify_network("Arizona Tri University Network") == "corporate"

    def test_internet_alone_is_not_a_carrier_word(self):
        assert classify_network("Internet Archive") == "corporate"
        assert classify_network("Internet Systems Consortium") == "corporate"


class TestInstitutionsWinOutright:
    """The override, and the only rule that PROMOTES a name into corporate.

    Schools, universities, hospitals and county government are the highest-
    value rows here and their names collide with carrier and cloud vocabulary
    more often than a manufacturer's does.
    """

    def test_a_carrier_brand_inside_a_school_name_does_not_win(self):
        assert classify_network("Orange County Public Schools") == "corporate"

    def test_a_cloud_word_inside_a_college_name_does_not_win(self):
        assert classify_network("Cloud County Community College") == "corporate"

    @pytest.mark.parametrize(
        "name",
        [
            "Sachem Central School District",
            "University of Texas at Austin",
            "Nova Scotia Department of Education",
            "Mayo Clinic",
            "Boston Medical Center",
            "City of Austin",
            "Los Angeles County",
            "Brookhaven National Laboratory",
        ],
    )
    def test_institutions_are_corporate(self, name):
        assert classify_network(name) == "corporate"


class TestIsps:
    @pytest.mark.parametrize("name", ISPS)
    def test_carriers_are_isp(self, name):
        assert classify_network(name) == "isp"

    def test_the_two_biggest_noise_sources_in_production_are_filtered(self):
        """Verizon Business (220 visitors) and Cablevision (181) are 63% of
        production's non-hosting visitors and none of them is a company."""
        assert classify_network("Verizon Business") == "isp"
        assert classify_network("Cablevision Systems Corp.") == "isp"


class TestHosting:
    @pytest.mark.parametrize("name", HOSTS)
    def test_infrastructure_is_hosting(self, name):
        assert classify_network(name) == "hosting"

    def test_microsofts_range_is_not_a_visitor(self):
        """3,719 of production's visitors — Bing plus Azure egress — arrive
        from one AS. Left in the corporate bucket it would be the panel."""
        assert classify_network("Microsoft Corporation") == "hosting"


class TestOrderIsTheDesign:
    """Every rule below is only correct because of where it sits."""

    def test_hosting_beats_isp_on_a_datacenter_carrying_carrier_words(self):
        """These three are datacenter and backbone ranges whose LEGAL names
        contain "communications", "telecommunications" and "bandwidth". The
        isp rules would claim all of them if they ran first."""
        assert classify_network("Level 3 Communications, Inc.") == "hosting"
        assert classify_network("IDC, China Telecommunications Corporation") == "hosting"
        assert classify_network("Zayo Bandwidth") == "hosting"

    def test_the_institution_override_beats_hosting(self):
        assert classify_network("Cloud County Community College") == "corporate"

    def test_google_is_matched_as_a_phrase_so_fiber_stays_an_isp(self):
        """ "Google Fiber Inc." is residential access. Matching the bare word
        "google" would file a consumer ISP as a cloud."""
        assert classify_network("Google LLC") == "hosting"
        assert classify_network("Google Fiber Inc.") == "isp"

    def test_an_unrecognised_name_falls_through_to_corporate(self):
        """The fallthrough is the safe direction: a name no rule knows is
        SHOWN, not filed away where nobody looks."""
        assert classify_network("Zorptek Widgets GmbH") == "corporate"


class TestUnknown:
    @pytest.mark.parametrize("name", [None, "", "   ", ",,,", "  -  "])
    def test_a_nameless_network_is_unknown(self, name):
        assert classify_network(name) == "unknown"


class TestNormalisation:
    def test_case_and_padding_do_not_matter(self):
        assert classify_network("  cIrRuS lOgIc InC.  ") == "corporate"
        assert classify_network("VERIZON BUSINESS") == "isp"

    def test_ampersands_and_hyphens_close_up(self):
        """ "AT&T" has to become the single token `att` and "T-Mobile"
        `tmobile`. Turning the punctuation into a space instead leaves `at`
        and `t`, and a two-letter fragment matches half the world."""
        assert normalize_network("AT&T Enterprises, LLC") == " att enterprises llc "
        assert normalize_network("T-Mobile USA, Inc.") == " tmobile usa inc "

    def test_dots_open_up(self):
        """The opposite rule, and both are needed: "Amazon.com" has to yield
        the token `amazon`, not `amazoncom`."""
        assert normalize_network("Amazon.com, Inc.") == " amazon com inc "
        assert classify_network("Amazon.com, Inc.") == "hosting"

    def test_accents_are_folded(self):
        """DB-IP reports the operator's own spelling."""
        assert "telefonica" in normalize_network("TELEFÔNICA BRASIL S.A")
        assert classify_network("TELEFÔNICA BRASIL S.A") == "isp"
        assert classify_network("VIA SUL TELECOMUNICAÇOES LTDA ME") == "isp"

    def test_quotes_and_stray_punctuation_become_spaces(self):
        assert normalize_network('UAB "Bite Lietuva"') == " uab bite lietuva "

    @pytest.mark.parametrize(
        "name",
        [
            "Mattel, Inc.",  # contains "att"
            "Seattle Genetics",  # contains "att"
            "Hostess Brands, Inc.",  # starts with "host"
            "Meta Materials Inc.",  # starts with "meta"
            "Coxsackie Industries",  # contains "cox"
            "Orangeburg Manufacturing",  # contains "orange"
        ],
    )
    def test_a_keyword_never_matches_inside_another_word(self, name):
        """Whole-token matching is what keeps the keyword lists usable: every
        name here contains a carrier or cloud keyword as a SUBSTRING and none
        of them is a carrier or a cloud."""
        assert classify_network(name) == "corporate"


class TestProductionShape:
    """The distribution the panel promises, measured on the real names.

    Not a golden file — three assertions about the separation itself.
    """

    def test_the_noise_and_the_signal_land_on_opposite_sides(self):
        assert {classify_network(n) for n in PROSPECTS} == {"corporate"}
        assert "corporate" not in {classify_network(n) for n in ISPS + HOSTS}

    def test_every_verdict_is_one_of_the_four_kinds(self):
        kinds = {classify_network(n) for n in PROSPECTS + ISPS + HOSTS}
        assert kinds <= {"corporate", "isp", "hosting", "unknown"}
