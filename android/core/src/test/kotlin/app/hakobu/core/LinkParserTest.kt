package app.hakobu.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Same cases as test/smoke.mjs and test/extract.mjs on desktop, so both apps parse links identically. */
class LinkParserTest {
    @Test
    fun parsesMagnetsHashesHostersAndTorrentUrls() {
        val e = LinkParser.parse(
            """grab these:
            https://example.com/files/a%20b.zip, https://mega.nz/file/abc#key
            magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567&dn=Ubuntu+ISO&tr=udp://x
            http://site.org/x.torrent  fedcba9876543210fedcba9876543210fedcba98"""
        )
        assertEquals(5, e.size)
        assertEquals(listOf(LinkKind.TORRENT, LinkKind.HTTP, LinkKind.HTTP, LinkKind.TORRENT, LinkKind.TORRENT), e.map { it.kind })
        assertEquals("Ubuntu ISO", e[0].name)
        assertEquals("0123456789abcdef0123456789abcdef01234567", e[0].infoHash)
        assertEquals("a b.zip", e[1].name)
        assertTrue(e[2].hoster)
        assertEquals("magnet:?xt=urn:btih:fedcba9876543210fedcba9876543210fedcba98", e[4].source)
    }

    @Test
    fun unescapesHtmlInLinks() {
        val e = LinkParser.parse("https://example.com/a.zip?a=b&amp;s=20")
        assertEquals("https://example.com/a.zip?a=b&s=20", e[0].source)
    }

    @Test
    fun normalizesEveryFormOfAnXPost() {
        val want = "https://x.com/NASA/status/123"
        listOf(
            "https://x.com/NASA/status/123?a=b&amp;s=20",
            "https://x.com/NASA/status/123?s=20&t=abc",
            "https://x.com/NASA/status/123/video/1",
            "https://x.com/NASA/status/123/photo/2?s=46",
            "https://twitter.com/NASA/status/123",
            "https://www.twitter.com/NASA/status/123",
            "https://mobile.twitter.com/NASA/status/123",
            "https://vxtwitter.com/NASA/status/123",
            "https://fxtwitter.com/NASA/status/123",
            "https://d.fxtwitter.com/NASA/status/123",
            "https://fixupx.com/NASA/status/123",
        ).forEach { url ->
            val e = LinkParser.parse(url).single()
            assertEquals(want, e.source, url)
            assertEquals(LinkKind.MEDIA, e.kind, url)
        }
        assertEquals("https://x.com/i/status/123", LinkParser.parse("https://twitter.com/i/status/123").single().source)
        assertEquals("https://x.com/i/web/status/123", LinkParser.parse("https://x.com/i/web/status/123?s=20").single().source)
        assertEquals("https://x.com/NASA", LinkParser.parse("https://x.com/NASA").single().source)
        assertEquals(LinkKind.HTTP, LinkParser.parse("https://notx.com/a/status/123").single().kind)
    }

    @Test
    fun deduplicatesByInfoHash() {
        val e = LinkParser.parse("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567 0123456789abcdef0123456789abcdef01234567")
        assertEquals(1, e.size)
    }

    @Test
    fun base32Magnet() {
        // base32 of 20 zero bytes is 32 'A's
        assertEquals("0".repeat(40), LinkParser.infoHashFromMagnet("magnet:?xt=urn:btih:" + "A".repeat(32)))
    }

    @Test
    fun mediaLinksAndPlaylists() {
        val e = LinkParser.parse("https://www.youtube.com/watch?v=dQw4w9WgXcQ https://m.youtube.com/playlist?list=PL123")
        assertEquals(listOf(LinkKind.MEDIA, LinkKind.MEDIA), e.map { it.kind })
        assertFalse(e[0].playlist)
        assertTrue(e[1].playlist)
    }

    @Test
    fun trimsTrailingPunctuation() {
        assertEquals("https://example.com/a.zip", LinkParser.parse("(see https://example.com/a.zip).")[0].source)
    }

    @Test
    fun packageNames() {
        assertEquals("My.Show.S01", Names.packageName("My.Show.S01.part03.rar"))
        assertEquals("backup", Names.packageName("backup.7z.001"))
        assertEquals("Movie", Names.packageName("Movie CD2.avi"))
        assertEquals("Movie.2010.1080p", Names.packageName("Movie.2010.1080p.mkv"))
    }

    @Test
    fun sanitizeAndContentDisposition() {
        assertEquals("a_b_c", Names.sanitize("a/b:c. "))
        assertEquals("download", Names.sanitize("..."))
        assertEquals("named by server.bin", Names.fromResponse("attachment; filename=\"named by server.bin\"", "http://x/y"))
        assertEquals("ü.txt", Names.fromResponse("attachment; filename*=UTF-8''%C3%BC.txt", "http://x/y"))
        assertEquals("y z.iso", Names.fromResponse(null, "http://x/y%20z.iso"))
        assertEquals("f (2).zip", Names.uniqueName("f.zip") { it == "f.zip" || it == "f (1).zip" })
    }
}
