"""Read-time bot/human UA classification (services/traffic_segments.py).

The fixture strings are REAL user agents from the 2026-08-21 production
flood — the exact rows this classifier exists to segment."""

from app.services.traffic_segments import crawler_family, is_bot, split_user_agents

META_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/145.0.0.0 Safari/537.36 (compatible; meta-externalagent/1.1 "
    "(+https://developers.facebook.com/docs/sharing/webmasters/crawler))"
)
PERPLEXITY_UA = (
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; "
    "+https://perplexity.ai/perplexitybot)"
)
DUCKASSIST_UA = "DuckAssistBot/1.2; (+http://duckduckgo.com/duckassistbot.html)"
GSA_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_6_0 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) GSA/434.2.965950419 Mobile/15E148 Safari/604.1"
)
CHROME_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/151.0.0.0 Safari/537.36"
)
CUBOT_UA = (
    "Mozilla/5.0 (Linux; Android 10; CUBOT NOTE 7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
)


class TestIsBot:
    def test_meta_externalagent_is_bot(self):
        assert is_bot(META_UA) is True

    def test_perplexitybot_is_bot(self):
        assert is_bot(PERPLEXITY_UA) is True

    def test_duckassistbot_is_bot(self):
        assert is_bot(DUCKASSIST_UA) is True

    def test_googlebot_is_bot(self):
        assert is_bot("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")

    def test_curl_is_bot(self):
        assert is_bot("curl/8.5.0") is True

    def test_google_search_app_is_human(self):
        # GSA/… is the Google Search APP — a human's mobile browser.
        assert is_bot(GSA_UA) is False

    def test_plain_chrome_is_human(self):
        assert is_bot(CHROME_UA) is False

    def test_cubot_phone_is_human(self):
        # "CUBOT" contains the letters b-o-t; the phone is a human device.
        assert is_bot(CUBOT_UA) is False

    def test_none_and_empty_are_human(self):
        assert is_bot(None) is False
        assert is_bot("") is False

    def test_hyphenated_and_tokenless_crawlers_are_bots(self):
        # These previously classified HUMAN: 'bot-' had no terminator match,
        # and the InspectionTool/Other/Preview names carry no 'bot' at all —
        # leaving their family entries as unreachable dead config.
        for ua in (
            "Googlebot-Image/1.0",
            "AdsBot-Google (+http://www.google.com/adsbot.html)",
            "Mozilla/5.0 (compatible; Google-InspectionTool/1.0;)",
            "GoogleOther",
            "Mozilla/5.0 (compatible; bingbot/2.0) BingPreview/1.0b",
        ):
            assert is_bot(ua) is True, ua


class TestCrawlerFamily:
    def test_meta(self):
        assert crawler_family(META_UA) == "Meta"

    def test_perplexity(self):
        assert crawler_family(PERPLEXITY_UA) == "Perplexity"

    def test_duckduckgo(self):
        assert crawler_family(DUCKASSIST_UA) == "DuckDuckGo"

    def test_unknown_bot_folds_to_other(self):
        assert crawler_family("curl/8.5.0") == "Other bots"

    def test_human_has_no_family(self):
        assert crawler_family(CHROME_UA) is None
        assert crawler_family(None) is None

    def test_google_and_bing_variants_resolve(self):
        assert crawler_family("Googlebot-Image/1.0") == "Google"
        assert crawler_family("AdsBot-Google (+http://www.google.com/adsbot.html)") == "Google"
        assert crawler_family("Mozilla/5.0 (compatible; Google-InspectionTool/1.0;)") == "Google"
        assert crawler_family("GoogleOther") == "Google"
        assert crawler_family("BingPreview/1.0b") == "Bing"


class TestSplitUserAgents:
    def test_partition(self):
        bots, humans = split_user_agents([META_UA, CHROME_UA, GSA_UA, PERPLEXITY_UA, None])
        assert bots == {META_UA, PERPLEXITY_UA}
        assert humans == {CHROME_UA, GSA_UA}
