<?php
/**
 * Tests for the mail/ PHP — the signature template, and soon the ccsignature
 * plugin's pure parts.
 *
 *   php mail/tests/run.php            run everything
 *   php mail/tests/run.php template   run one file (matches on filename)
 *
 * NO COMPOSER, NO PHPUNIT, ON PURPOSE. The whole reason the Roundcube skin and
 * the calendar plugin ride the upstream image untouched is that neither pulls a
 * composer dependency, so Roundcube patch releases keep arriving for free.
 * Adding a dev dependency here would put a vendor/ tree next to code that is
 * bind-mounted into that image, which is the one thing this deployment has
 * consistently refused to do. An assertion runner is about sixty lines; a
 * dependency is forever.
 *
 * Exit code is 0 only when every assertion passed, so this is usable from a
 * hook or CI without parsing the output.
 */

declare(strict_types=1);

final class T
{
    public static int $passed = 0;
    /** @var string[] */
    public static array $failures = [];
    private static string $group = '';

    public static function group(string $name): void
    {
        self::$group = $name;
        echo "\n  {$name}\n";
    }

    public static function ok(bool $cond, string $what): void
    {
        if ($cond) {
            self::$passed++;
            echo "    \033[32mok\033[0m   {$what}\n";
            return;
        }
        self::$failures[] = self::$group . ' :: ' . $what;
        echo "    \033[31mFAIL\033[0m {$what}\n";
    }

    /** Prints BOTH values on failure — a bare "expected true" wastes the run. */
    public static function same($expected, $actual, string $what): void
    {
        $cond = $expected === $actual;
        if (!$cond) {
            $what .= sprintf(
                "\n           expected: %s\n           actual:   %s",
                var_export($expected, true),
                var_export($actual, true)
            );
        }
        self::ok($cond, $what);
    }

    public static function contains(string $needle, string $haystack, string $what): void
    {
        self::ok(str_contains($haystack, $needle), $what . " [looking for: {$needle}]");
    }

    public static function notContains(string $needle, string $haystack, string $what): void
    {
        self::ok(!str_contains($haystack, $needle), $what . " [must not contain: {$needle}]");
    }
}

$filter = $argv[1] ?? '';
$files  = glob(__DIR__ . '/test_*.php') ?: [];
$files  = array_values(array_filter(
    $files,
    fn($f) => $filter === '' || str_contains(basename($f), $filter)
));

if (!$files) {
    fwrite(STDERR, "no test files matched" . ($filter ? " '{$filter}'" : '') . "\n");
    exit(1);
}

foreach ($files as $file) {
    echo "\n" . basename($file);
    require $file;
}

$failed = count(T::$failures);
echo "\n\n" . str_repeat('-', 60) . "\n";
if ($failed === 0) {
    echo "\033[32m" . T::$passed . " passed\033[0m\n";
    exit(0);
}
echo "\033[31m{$failed} failed\033[0m, " . T::$passed . " passed\n";
foreach (T::$failures as $f) {
    echo "  - {$f}\n";
}
exit(1);
