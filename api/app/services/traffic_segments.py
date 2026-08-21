"""Read-time bot/human classification of page-view user agents.

Classification happens at READ time (aggregation), never at write time, so
it applies retroactively to every stored row and the regex can be refined
without a migration. The analytics endpoint filters SQL aggregations by
first classifying the window's DISTINCT user agents here (a small set),
then filtering rows with plain IN / NOT IN — exact regex semantics with the
aggregation staying in SQL.

Tuned against the real UAs in production page_views (2026-08-21 flood):
meta-externalagent (Meta's crawler, ~90% of the flood), PerplexityBot,
DuckAssistBot — while the iPhone "GSA/…" rows are the Google Search App,
a human browser, and must classify HUMAN. `(?<!cu)bot` keeps Cubot phones
(Android UAs like "CUBOT NOTE 7") out of the bot bucket while Googlebot,
GPTBot, DuckAssistBot still match.
"""

import re

BOT_UA_RE = re.compile(
    r"(?:"
    # Googlebot/…, GPTBot), DuckAssistBot, Googlebot-Image, AdsBot-Google —
    # '-' is a terminator too; the (?<!cu) guard still keeps Cubot phones out.
    r"(?<!cu)bot(?:[\s/;)\]-]|$)"
    r"|crawler|spider|crawl(?:er)?/"
    # Google/Bing crawlers whose names carry no standalone 'bot' token:
    r"|google-inspectiontool|googleother|bingpreview"
    r"|externalagent|externalhit"  # meta-externalagent, facebookexternalhit
    r"|slurp|petalbot|bytespider"
    r"|gptbot|oai-searchbot|chatgpt-user"
    r"|claudebot|claude-web"
    r"|perplexity|duckassist"
    r"|semrush|ahrefs|mj12|dotbot|dataforseo|screaming\s?frog"
    r"|headlesschrome|phantomjs|lighthouse"
    r"|python-requests|python-httpx|aiohttp|scrapy|go-http-client|okhttp"
    r"|curl/|wget/|node-fetch|axios/"
    r"|pingdom|uptimerobot|statuscake"
    r")",
    re.IGNORECASE,
)

# Ordered: first match names the family. Substrings are matched lowercase.
_CRAWLER_FAMILIES: list[tuple[tuple[str, ...], str]] = [
    (("meta-externalagent", "facebookexternalhit"), "Meta"),
    (("googlebot", "google-inspectiontool", "googleother", "adsbot-google"), "Google"),
    (("bingbot", "bingpreview", "msnbot"), "Bing"),
    (("perplexity",), "Perplexity"),
    (("duckassist", "duckduckbot", "duckduckgo"), "DuckDuckGo"),
    (("gptbot", "oai-searchbot", "chatgpt-user"), "OpenAI"),
    (("claudebot", "claude-web"), "Anthropic"),
    (("amazonbot",), "Amazon"),
    (("applebot",), "Apple"),
    (("bytespider",), "ByteDance"),
    (("petalbot",), "Huawei Petal"),
    (("yandex",), "Yandex"),
    (("baiduspider",), "Baidu"),
    (("semrush", "ahrefs", "mj12", "dotbot", "dataforseo", "screaming"), "SEO tools"),
]


def is_bot(user_agent: str | None) -> bool:
    """None/empty classifies HUMAN — an absent UA carries no bot evidence."""
    if not user_agent:
        return False
    return bool(BOT_UA_RE.search(user_agent))


def crawler_family(user_agent: str | None) -> str | None:
    """Named crawler family for a BOT user agent; None for humans."""
    if not is_bot(user_agent):
        return None
    ua = (user_agent or "").lower()
    for needles, family in _CRAWLER_FAMILIES:
        if any(n in ua for n in needles):
            return family
    return "Other bots"


def split_user_agents(user_agents: list[str | None]) -> tuple[set[str], set[str]]:
    """Partition distinct UA strings into (bot_uas, human_uas). None is
    dropped — NULL user_agent rows are handled as human at the SQL layer."""
    bots: set[str] = set()
    humans: set[str] = set()
    for ua in user_agents:
        if ua is None:
            continue
        (bots if is_bot(ua) else humans).add(ua)
    return bots, humans
