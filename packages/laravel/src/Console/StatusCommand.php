<?php

namespace Itaja\Laravel\Console;

use Illuminate\Console\Command;
use Itaja\Laravel\Exceptions\ItajaException;
use Itaja\Laravel\Itaja;

class StatusCommand extends Command
{
    protected $signature = 'itaja:status {--json : Machine-readable output}';

    protected $description = 'List what differs between itaja.php and Itaja; exits 1 if anything does';

    public function handle(Itaja $itaja): int
    {
        try {
            $diff = $itaja->push(dryRun: true);
        } catch (ItajaException $e) {
            return Diff::fail($this, $e);
        }
        $changes = Diff::count($diff);

        if ($this->option('json')) {
            $this->line((string) json_encode($diff, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
        } else {
            $this->line('Itaja '.strtoupper($itaja->mode()).' catalogue — '.($changes > 0 ? 'differs from your code' : 'in sync').":\n");
            Diff::print($this, $diff);
        }

        return $changes > 0 ? self::FAILURE : self::SUCCESS;
    }
}
