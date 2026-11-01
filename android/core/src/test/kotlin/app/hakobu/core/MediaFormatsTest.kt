package app.hakobu.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class MediaFormatsTest {
    @Test
    fun sectionArgsCutToTheChosenPart() {
        assertEquals(listOf("--download-sections", "*30-45.5", "--force-keyframes-at-cuts"), MediaFormats.sectionArgs(30.0, 45.5))
        assertEquals(listOf("--download-sections", "*0.125-3725", "--force-keyframes-at-cuts"), MediaFormats.sectionArgs(0.125, 3725.0))
    }

    @Test
    fun noSectionMeansTheWholeTrack() {
        assertTrue(MediaFormats.sectionArgs(null, null).isEmpty())
        assertTrue(MediaFormats.sectionArgs(10.0, null).isEmpty())
        assertTrue(MediaFormats.sectionArgs(45.0, 30.0).isEmpty())
        assertNull(MediaFormats.clipLabel(5.0, 5.0))
    }

    @Test
    fun explainsXPostsWithNoVideo() {
        assertTrue("signed-in" in MediaFormats.friendlyError("ERROR: [twitter] 2116469109974270436: No video could be found in this tweet"))
        assertTrue(MediaFormats.needsXSignIn(MediaFormats.friendlyError(MediaFormats.X_LOGIN_REQUIRED)))
        assertTrue(MediaFormats.needsXSignIn(MediaFormats.friendlyError(MediaFormats.X_SIGNIN_REJECTED)))
        assertTrue(MediaFormats.needsXSignIn(MediaFormats.friendlyError("ERROR: [twitter] NSFW tweet requires authentication")))
        assertTrue(!MediaFormats.needsXSignIn(MediaFormats.friendlyError(MediaFormats.X_GONE)))
        assertTrue("no video or photos" in MediaFormats.friendlyError(MediaFormats.X_NO_MEDIA))
        assertTrue("deleted" in MediaFormats.friendlyError(MediaFormats.X_GONE))
    }

    @Test
    fun xCookiesGoOnlyToXLinks() {
        val cookies = XCookies.fromHeader("guest_id=g; auth_token=FAKE1; ct0=FAKE2; lang=en")
        assertEquals(mapOf("auth_token" to "FAKE1", "ct0" to "FAKE2"), cookies)
        assertTrue(XCookies.isSignedIn(cookies))
        assertTrue(!XCookies.isSignedIn(mapOf("ct0" to "FAKE2")))
        assertTrue(!XCookies.isSignedIn(XCookies.fromHeader(null)))
        assertEquals(
            listOf(
                "# Netscape HTTP Cookie File",
                ".x.com\tTRUE\t/\tTRUE\t31536100\tauth_token\tFAKE1",
                ".x.com\tTRUE\t/\tTRUE\t31536100\tct0\tFAKE2",
                ".twitter.com\tTRUE\t/\tTRUE\t31536100\tauth_token\tFAKE1",
                ".twitter.com\tTRUE\t/\tTRUE\t31536100\tct0\tFAKE2",
            ),
            XCookies.netscape(cookies, 100).trim().lines(),
        )
        assertEquals(listOf("--cookies", "f"), XCookies.args("https://x.com/a/status/1", "f"))
        assertEquals(listOf("--cookies", "f"), XCookies.args("https://mobile.twitter.com/a/status/1", "f"))
        for (other in listOf("https://www.youtube.com/watch?v=a", "https://notx.com/a", "https://evil.com/x.com/a", "https://x.com.evil.com/a", "https://evil.com#.x.com/", "https://evil.com?.x.com/", "https://me@evil.com/.x.com/")) {
            assertTrue(XCookies.args(other, "f").isEmpty(), other)
        }
        assertTrue(XCookies.args("https://x.com/a/status/1", null).isEmpty())
    }

    @Test
    fun readsXEmbedData() {
        assertEquals(XPost.LoginRequired, XPosts.parse("""{"__typename":"TweetTombstone","tombstone":{}}"""))
        assertEquals(XPost.Gone, XPosts.parse("{}"))
        assertEquals(XPost.Gone, XPosts.parse("not json"))
        assertEquals(XPost.NoMedia, XPosts.parse("""{"__typename":"Tweet","id_str":"1","text":"hi"}"""))
        assertEquals(XPost.HasVideo, XPosts.parse("""{"__typename":"Tweet","mediaDetails":[{"type":"video"}]}"""))
        assertEquals(XPost.HasVideo, XPosts.parse("""{"__typename":"Tweet","mediaDetails":[{"type":"animated_gif"}]}"""))
        val photos = XPosts.parse("""{"__typename":"Tweet","text":"Moon view https://t.co/abc","user":{"screen_name":"apod"},"mediaDetails":[{"type":"photo","media_url_https":"https://pbs.twimg.com/media/A.jpg"},{"type":"photo","media_url_https":"https://pbs.twimg.com/media/B.png"}]}""")
        assertEquals(XPost.Photos(listOf("https://pbs.twimg.com/media/A.jpg?name=orig", "https://pbs.twimg.com/media/B.png?name=orig"), "Moon view", "apod"), photos)
        assertEquals("2116469109974270436", XPosts.statusId("https://x.com/a/status/2116469109974270436"))
    }

    @Test
    fun clipLabels() {
        assertEquals("0:30–0:45", MediaFormats.clipLabel(30.0, 45.9))
        assertEquals("59:59–1:02:05", MediaFormats.clipLabel(3599.0, 3725.0))
    }
}
