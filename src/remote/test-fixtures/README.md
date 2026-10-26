# Synthetic loopback TLS fixture

`loopback-test-cert.pem` and `loopback-test-key.pem` are a deliberately public,
synthetic self-signed test certificate and its disposable test key. They are not
deployment credentials and must never be used for a live server. The certificate
is valid only for `calendar.synthetic.invalid`.

Tests explicitly trust this certificate in an isolated transport instance. The
production configuration has no custom CA or certificate-verification override.
