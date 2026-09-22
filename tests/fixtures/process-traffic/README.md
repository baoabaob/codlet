These are PUBLIC test keys and certificates. They must never be installed in an
OS trust store or used for a live authenticated session. The fixture leaf covers
the deliberately intercepted built-in provider names so the official binary can
exercise its unmodified provider selection with synthetic credentials. The probe
answers locally and never forwards fixture credentials to those public services.

`ca.pem` is the fixture trust anchor. `cert.pem` is a CA-signed server leaf
(`CA:FALSE`, serverAuth). `key.pem` is that leaf's public test private key. The CA
private key is not distributed. The certificates expire in September 2036.
