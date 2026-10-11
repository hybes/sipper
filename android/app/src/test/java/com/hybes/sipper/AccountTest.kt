package com.hybes.sipper

import org.junit.Assert.*
import org.junit.Test

class AccountTest {
    private val account = SipAccount(label = "Example", username = "100", password = "fixture", domain = "pbx.example.invalid")
    @Test fun systemPresentationsUseOneCompleteConferenceAndRejectOldGroups() {
        val first = PhoneCall("one", "account", "First", false, "Connected", connected = true)
        val second = first.copy(id = "two", remote = "Second")
        val unrelated = first.copy(id = "other", accountId = "another", held = true)
        val group = listOf(first.copy(conferenceId = "merge-one"), second.copy(conferenceId = "merge-one"), unrelated)
        assertEquals(listOf("one", "two"), group.presentationMembers("conference:merge-one").map { it.id })
        assertEquals(listOf(unrelated), group.presentationMembers(unrelated.presentationId))
        assertTrue(group.presentationMembers(first.id).isEmpty())
        assertTrue(group.take(1).presentationMembers("conference:merge-one").isEmpty())
        assertTrue((group + first.copy(id = "third", conferenceId = "merge-one")).presentationMembers("conference:merge-one").isEmpty())
        assertTrue(group.map { if (it.id == "two") it.copy(state = "Ended") else it }.presentationMembers("conference:merge-one").isEmpty())
        val regrouped = group.map { if (it.conferenceId != null) it.copy(conferenceId = "merge-two") else it }
        assertTrue(regrouped.presentationMembers("conference:merge-one").isEmpty())
        assertEquals(2, regrouped.presentationMembers("conference:merge-two").size)
        val separate = listOf(first.copy(held = true), second.copy(held = true), unrelated)
        assertTrue(separate.presentationMembers("conference:merge-one").isEmpty())
        assertEquals(listOf(first.id), separate.presentationMembers(first.presentationId).map { it.id })
    }
    @Test fun recentCallsUseTheirSavedTargetAndExactAvailableAccount() {
        val uri = "sip:200@example.invalid;transport=tls"
        assertEquals(uri, incomingDestination("\"Reception\" <$uri>", account))
        assertEquals(uri, incomingDestination(uri, account))
        for (invalid in listOf("200", "Reception", "<sip:200@example.invalid> <sip:300@example.invalid>",
            "<sip:200@example.invalid>extra", "sip:200@example.invalid\r\nHeader: injected", "<https://example.invalid>",
            "<sip:200@example.invalid?Subject=test>", ">sip:200@example.invalid<")) assertNull(incomingDestination(invalid, account))
        val managed = account.copy(managedDeviceId = "device", managedMode = "gateway", expiresAt = System.currentTimeMillis() + 60_000)
        assertNull(incomingDestination(uri, managed))
        val call = RecentCall("call", account.id, "Reception", true, false, 1, "200", "device", "Office")
        assertEquals(managed, call.callingAccount(listOf(managed)))
        for (values in listOf(emptyList(), listOf(account), listOf(managed.copy(id = "other")),
            listOf(managed.copy(enabled = false)), listOf(managed.copy(expiresAt = 0)), listOf(managed.copy(managedDeviceId = "other")))) {
            assertThrows(IllegalStateException::class.java) { call.callingAccount(values) }
        }
        assertThrows(IllegalStateException::class.java) { call.copy(destination = null).callingAccount(listOf(managed)) }
        assertThrows(IllegalArgumentException::class.java) { call.copy(destination = "Reception").callingAccount(listOf(managed)) }
        assertThrows(IllegalArgumentException::class.java) { call.copy(destination = uri).callingAccount(listOf(managed)) }
        assertEquals(account, call.copy(managedDeviceId = null, destination = uri).callingAccount(listOf(account)))
    }
    @Test fun sharedContactsOnlyUseTheSelectedCurrentCustomerAccount() {
        val managed = account.copy(id = "managed", managedDeviceId = "device", expiresAt = System.currentTimeMillis() + 60000)
        assertEquals(managed, directoryAccount(listOf(account, managed), managed.id, "device"))
        for (value in listOf(account, managed.copy(enabled = false), managed.copy(expiresAt = 0), managed.copy(managedDeviceId = "another-device")))
            assertThrows(ManagedFailure::class.java) { directoryAccount(listOf(value), value.id, "device") }
        assertThrows(ManagedFailure::class.java) { directoryAccount(emptyList(), managed.id, "device") }
        val contact = DirectoryContact("contact", "Example Reception", "Fictional Company", listOf(DirectoryNumber("Work", "+12025550101")), 1, "")
        assertTrue(contact.matches("reception")); assertTrue(contact.matches("COMPANY")); assertTrue(contact.matches("(202) 555-0101"))
        assertFalse(contact.matches("https://example.invalid/202")); assertFalse(contact.matches("999"))
    }
    @Test fun validationAndDiallingPreserveTheIntendedDestination() {
        account.validate(personal = true)
        assertEquals("sip:+441234567890@pbx.example.invalid", dialDestination("+44 (1234) 567890", account))
        assertEquals("sip:*97@pbx.example.invalid", dialDestination("*97", account))
        assertEquals("sips:100@example.invalid", dialDestination("sips:100@example.invalid", account))
        listOf("hello123", "123\r\nINVITE", "https://example.invalid", "+12+34", "+", " ").forEach { raw ->
            assertThrows(IllegalArgumentException::class.java) { dialDestination(raw, account) }
        }
        assertThrows(IllegalArgumentException::class.java) { account.copy(domain = "example.invalid;transport=udp").validate() }
        assertThrows(IllegalArgumentException::class.java) { account.copy(port = 0).validate() }
        assertThrows(IllegalArgumentException::class.java) { account.copy(managedDeviceId = "device", expiresAt = 100).validate(personal = true) }
        assertFalse(account.copy(managedDeviceId = "device", expiresAt = 100).usable(101))
        assertTrue(account.usable(Long.MAX_VALUE))
        assertFalse(account.toString().contains(account.password))
        val gateway = account.copy(managedDeviceId = "device", managedMode = "gateway", expiresAt = 100)
        gateway.validate()
        assertThrows(IllegalArgumentException::class.java) { gateway.copy(transport = "udp").validate() }
        assertThrows(IllegalArgumentException::class.java) { gateway.copy(srtp = "optional").validate() }
        assertThrows(IllegalArgumentException::class.java) { gateway.copy(managedDeviceId = null).validate() }
        assertThrows(IllegalArgumentException::class.java) { dialDestination("sip:100@different.example.invalid", gateway) }
        assertEquals("sip:*97@pbx.example.invalid", dialDestination("*97", gateway))
        assertEquals("sip:${"1".repeat(128)}@pbx.example.invalid", dialDestination("1".repeat(128), gateway))
        assertThrows(IllegalArgumentException::class.java) { dialDestination("1".repeat(129), gateway) }
        val named = account.copy(displayName = "Example \"Team\"", voicemailNumber = "*98", stunServer = "stun.example.invalid:3478")
        named.validate()
        assertEquals("\"Example \\\"Team\\\"\" <sip:100@pbx.example.invalid>", named.identityUri)
        assertThrows(IllegalArgumentException::class.java) { named.copy(voicemailNumber = "phone123").validate() }
        assertThrows(IllegalArgumentException::class.java) { named.copy(stunServer = "https://example.invalid").validate() }
    }
}
