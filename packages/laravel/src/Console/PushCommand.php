<?php

namespace Itaja\Laravel\Console;

use Illuminate\Console\Command;
use Illuminate\Support\Str;
use Itaja\Laravel\Itaja;
use Itaja\Laravel\Exceptions\ItajaException;

class PushCommand extends Command
{
    protected $signature = 'itaja:push {--dry-run : Show the diff, write nothing} {--force : Apply without asking (CI, deploy pipeline)}';

    protected $description = 'Sync the catalogue declared in itaja.php to Itaja';

    public function handle(Itaja $itaja): int
    {
        try {
            $banner = 'Itaja '.strtoupper($itaja->mode()).' catalogue';
            $diff = $itaja->push(dryRun: true);
            $changes = Diff::count($diff);

            if ($this->option('dry-run')) {
                $this->line("{$banner} — ".($changes > 0 ? 'differs from your code' : 'in sync').":\n");
                Diff::print($this, $diff);

                return self::SUCCESS;
            }
            if ($changes === 0) {
                $this->info("{$banner} is already in sync. Nothing to push.");

                return self::SUCCESS;
            }

            $this->line("{$banner} — changes to apply:\n");
            Diff::print($this, $diff);
            $this->newLine();

            if (! $this->option('force')) {
                if (! $this->input->isInteractive()) {
                    $this->error('Not a terminal: pass --force to apply.');

                    return self::FAILURE;
                }
                if (! $this->confirm("Apply these changes to your {$itaja->mode()} catalogue?")) {
                    $this->error('Aborted.');

                    return self::FAILURE;
                }
            }

            $applied = $itaja->push(idempotencyKey: (string) Str::uuid());
            $s = $applied['summary'] ?? [];
            $this->info(sprintf('Pushed: %d created · %d changed · %d archived.', $s['created'] ?? 0, $s['changed'] ?? 0, $s['archived'] ?? 0));

            return self::SUCCESS;
        } catch (ItajaException $e) {
            return Diff::fail($this, $e);
        }
    }
}
