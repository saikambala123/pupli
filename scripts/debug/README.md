# Debug scripts

Ad-hoc harnesses used while tracing specific autofill bugs. They are not part of
`npm test` — run them directly when you need to watch one behaviour in isolation.

    node scripts/debug/current-job.mjs     # which experience row gets "I currently work here"
    CUR=1 node scripts/debug/row-shapes.mjs  # how a profile's rows map onto repeated blocks

Both need a Chromium binary; set `CHROMIUM_PATH` if it is not on the default
Playwright path.
