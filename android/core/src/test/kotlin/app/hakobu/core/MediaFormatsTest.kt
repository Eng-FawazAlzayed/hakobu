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
    fun clipLabels() {
        assertEquals("0:30–0:45", MediaFormats.clipLabel(30.0, 45.9))
        assertEquals("59:59–1:02:05", MediaFormats.clipLabel(3599.0, 3725.0))
    }
}
