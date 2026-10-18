"""Mount the webhook route in your framework: Django, FastAPI / Starlette, Flask.

Each adapter only reads the raw body and the headers, then hands them to
``itaja.webhooks`` (:class:`itaja.handler.WebhookProcessor`)."""
