<?php

namespace Itaja\Laravel\Console;

use Illuminate\Console\Command;
use Itaja\Laravel\Exceptions\ItajaException;

/** @internal */
final class Diff
{
    /** @param  array<string, mixed>  $diff */
    public static function count(array $diff): int
    {
        $s = $diff['summary'] ?? [];

        return (int) ($s['created'] ?? 0) + (int) ($s['changed'] ?? 0) + (int) ($s['archived'] ?? 0);
    }

    /** @param  array<string, mixed>  $diff */
    public static function print(Command $command, array $diff): void
    {
        $marks = ['created' => '+', 'changed' => '~', 'archived' => '-', 'unchanged' => ' '];
        foreach ($diff['changes'] ?? [] as $c) {
            if (($c['action'] ?? '') === 'unchanged') {
                continue;
            }
            $where = ! empty($c['product']) ? $c['product'].'/' : '';
            $version = isset($c['version']) ? ' v'.$c['version'] : '';
            $fields = ! empty($c['fields']) ? ' ('.implode(', ', $c['fields']).')' : '';
            $command->line(sprintf('  %s %s %s%s%s%s', $marks[$c['action'] ?? ''] ?? '?', $c['kind'] ?? '', $where, $c['key'] ?? '', $version, $fields));
        }
        $s = $diff['summary'] ?? [];
        $command->line(sprintf("\n  %d created · %d changed · %d archived · %d unchanged", $s['created'] ?? 0, $s['changed'] ?? 0, $s['archived'] ?? 0, $s['unchanged'] ?? 0));
    }

    public static function fail(Command $command, ItajaException $e): int
    {
        $command->error("Itaja error {$e->status} {$e->errorCode}: {$e->getMessage()}");
        $issues = $e->details['issues'] ?? [];
        foreach (is_array($issues) ? $issues : [] as $issue) {
            $command->line("  - {$issue['path']}: {$issue['message']}");
        }

        return Command::FAILURE;
    }
}
