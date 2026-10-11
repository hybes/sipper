package com.hybes.sipper

import java.net.URI
import java.net.URLDecoder

/** A customer hint only: the signed-in identity must still redeem it with the configured server. */
internal fun setupReference(value: String, origin: String): String {
    fun invalid(): Nothing = throw ManagedFailure("invalid_setup_link", "This setup link is invalid or belongs to another Sipper server.")
    if (value.toByteArray(Charsets.UTF_8).size > 4096) invalid()
    val url = runCatching { URI(value.trim()) }.getOrElse { invalid() }
    val expected = URI(origin)
    fun sameOrigin(candidate: URI): Boolean {
        fun port(uri: URI) = if (uri.port >= 0) uri.port else if (uri.scheme.equals("https", true)) 443 else 80
        return candidate.scheme.equals(expected.scheme, true) && candidate.host?.equals(expected.host, true) == true && port(candidate) == port(expected)
    }
    if (url.rawUserInfo != null) invalid()
    val reference = if (url.scheme in setOf("http", "https")) {
        if (!sameOrigin(url) || url.rawPath != "/portal/setup" || url.rawQuery != null || !url.rawFragment.orEmpty().startsWith("ref=")) invalid()
        url.rawFragment.substring(4)
    } else {
        if (url.scheme != "sipper" || url.host != "setup" || url.rawPath.isNotEmpty() || url.port != -1 || url.rawFragment != null) invalid()
        val items = url.rawQuery?.split('&')?.map { item ->
            val pair = item.split('=', limit = 2)
            if (pair.size != 2) invalid()
            runCatching { URLDecoder.decode(pair[0], "UTF-8") to URLDecoder.decode(pair[1], "UTF-8") }.getOrElse { invalid() }
        } ?: invalid()
        if (items.size != 2 || items.map { it.first }.toSet() != setOf("server", "reference")) invalid()
        val server = runCatching { URI(items.first { it.first == "server" }.second) }.getOrElse { invalid() }
        if (!sameOrigin(server) || server.rawUserInfo != null || server.rawPath !in setOf("", "/") || server.rawQuery != null || server.rawFragment != null) invalid()
        items.first { it.first == "reference" }.second
    }
    if (!reference.matches(Regex("[A-Za-z0-9_-]{43}"))) invalid()
    return reference
}
