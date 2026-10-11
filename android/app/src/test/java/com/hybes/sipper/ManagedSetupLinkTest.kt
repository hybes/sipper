package com.hybes.sipper

import org.junit.Assert.*
import org.junit.Test
import java.net.URLEncoder

class ManagedSetupLinkTest {
    @Test fun setupLinksStayBoundToTheConfiguredServerAndExactShape() {
        val origin = "https://management.example.invalid"
        val reference = "a".repeat(43)
        val web = "$origin/portal/setup#ref=$reference"
        val native = "sipper://setup?server=${URLEncoder.encode(origin, "UTF-8")}&reference=$reference"
        assertEquals(reference, setupReference(web, origin))
        assertEquals(reference, setupReference(native, origin))
        assertEquals(reference, setupReference("$origin:443/portal/setup#ref=$reference", origin))
        for (value in listOf(web.replace("management.", "other."), web.replace("https:", "http:"),
            web.replace("/setup", "/other"), web.replace("#ref=", "?ref="), web + "&extra=1",
            native + "&reference=$reference", native + "&extra=1", native + "#x", native.replace("sipper://", "https://"),
            native.replace("setup?", "user@setup?"), native.replace("setup?", "setup:123?"),
            native.replace(reference, "short"), native.replace(URLEncoder.encode(origin, "UTF-8"), URLEncoder.encode("$origin/other", "UTF-8")),
            "x".repeat(4097))) {
            assertEquals(value.take(80), "invalid_setup_link", (runCatching { setupReference(value, origin) }.exceptionOrNull() as? ManagedFailure)?.kind)
        }
    }
}
