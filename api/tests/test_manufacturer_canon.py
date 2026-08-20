"""Canon service — the single home for manufacturer-name normalization.

Rules are the synthesis R3 canon (binding): the pairs below are the CONTRACT.
If an implementation change flips one of these, the merge behavior changed —
that is a design event, not a refactor.
"""

from app.services.manufacturer_canon import canon, domain_of, split_branch


class TestCanonEquality:
    def test_legal_suffix_folds(self):
        assert canon("Diodes Inc.") == canon("Diodes Incorporated") == "diodes"
        assert canon("Amphenol Ltd") == canon("Amphenol") == "amphenol"
        assert canon("TE Connectivity, Ltd.") == canon("TE Connectivity")

    def test_repeatable_suffix_fold(self):
        assert canon("Foo Co., Ltd.") == "foo"

    def test_ampersand_and_plus(self):
        assert canon("B&K Precision") == canon("B + K Precision")

    def test_separators_fold_to_space(self):
        assert canon("NXP-Semiconductors") == canon("NXP_Semiconductors") == canon("NXP/Semiconductors")


class TestCanonDistinctness:
    def test_usa_never_folds(self):
        # The load-bearing exclusion: "Microchip USA" is INDEPENDENT of
        # Microchip Technology (the CSV's own warning).
        assert canon("Microchip USA") != canon("Microchip Technology")
        assert canon("Microchip USA") == "microchip usa"

    def test_brand_families_stay_distinct(self):
        assert canon("Amphenol FCI") != canon("Amphenol")
        assert canon("NXP") != canon("NXP Semiconductors")

    def test_informative_parenthetical_kept(self):
        assert canon("Lumissil (ISSI)") != canon("Lumissil")
        assert canon("Lumissil (ISSI)") == "lumissil issi"


class TestParentheticalDrops:
    def test_acronym_of_base_drops(self):
        assert canon("Advanced Monolithic Systems (AMS)") == canon("Advanced Monolithic Systems")

    def test_repeat_of_base_drops(self):
        assert canon("Bourns (Bourns)") == canon("Bourns")

    def test_stop_words_drop(self):
        assert canon("Foo (Group)") == canon("Foo")
        assert canon("Bar (Manufacturing)") == canon("Bar")


class TestSplitBranch:
    def test_branch_extracted(self):
        assert split_branch("Bisco Industries (Bohemia)") == ("Bisco Industries", "Bohemia")

    def test_no_branch(self):
        assert split_branch("2J") == ("2J", None)

    def test_whitespace_tolerant(self):
        assert split_branch("  Acme  (East Coast) ") == ("Acme", "East Coast")


class TestDomainOf:
    def test_full_url(self):
        assert domain_of("https://www.2j-antennas.com/products") == "2j-antennas.com"

    def test_schemeless(self):
        assert domain_of("fdhelectronics.com") == "fdhelectronics.com"

    def test_none_and_empty(self):
        assert domain_of(None) is None
        assert domain_of("") is None
        assert domain_of("   ") is None
