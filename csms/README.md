To install dependencies:
```sh
bun install
```

To run:
```sh
bun run dev
```

The CSMS runs on http://localhost:6773.

To simulate one complete charger session:
```sh
bun run simulate:charger
```

The simulator sends BootNotification, status updates, StartTransaction,
MeterValues, and StopTransaction, then fetches the generated invoice.
