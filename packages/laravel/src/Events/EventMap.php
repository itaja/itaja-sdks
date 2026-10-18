<?php

namespace Itaja\Laravel\Events;

/** Every topic Itaja emits today, and the event class it is dispatched as. */
final class EventMap
{
    public const TOPICS = [
        'checkout.paid' => CheckoutPaid::class,
        'credits.granted' => CreditsGranted::class,
        'credits.consumed' => CreditsConsumed::class,
        'credits.expired' => CreditsExpired::class,
        'credits.low' => CreditsLow::class,
        'credits.clawed_back' => CreditsClawedBack::class,
        'license.issued' => LicenseIssued::class,
        'license.activated' => LicenseActivated::class,
        'license.deactivated' => LicenseDeactivated::class,
        'license.revoked' => LicenseRevoked::class,
        'license.expired' => LicenseExpired::class,
        'license.rotated' => LicenseRotated::class,
        'license.suspended' => LicenseSuspended::class,
        'license.resumed' => LicenseResumed::class,
        'license.updated' => LicenseUpdated::class,
        'invoice.paid' => InvoicePaid::class,
        'invoice.payment_failed' => InvoicePaymentFailed::class,
        'subscription.past_due' => SubscriptionPastDue::class,
        'subscription.canceled' => SubscriptionCanceled::class,
    ];

    /** @return class-string<ItajaEvent> */
    public static function classFor(string $type): string
    {
        return self::TOPICS[$type] ?? ItajaEvent::class;
    }
}
