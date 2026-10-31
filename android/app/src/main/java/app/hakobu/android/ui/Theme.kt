package app.hakobu.android.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val Dark = darkColorScheme(
    primary = Color(0xFF6E95FF),
    onPrimary = Color(0xFF0B0D12),
    primaryContainer = Color(0xFF263B6B),
    onPrimaryContainer = Color(0xFFDCE6FF),
    secondaryContainer = Color(0xFF263B6B),
    onSecondaryContainer = Color(0xFFEEF1F6),
    background = Color(0xFF0B0D12),
    onBackground = Color(0xFFEEF1F6),
    surface = Color(0xFF0B0D12),
    onSurface = Color(0xFFEEF1F6),
    onSurfaceVariant = Color(0xFF9AA3B5),
    surfaceContainerLowest = Color(0xFF0F1219),
    surfaceContainerLow = Color(0xFF11141B),
    surfaceContainer = Color(0xFF11141B),
    surfaceContainerHigh = Color(0xFF151922),
    surfaceContainerHighest = Color(0xFF222A3B),
    outline = Color(0xFF2E3546),
    outlineVariant = Color(0xFF262D3D),
    error = Color(0xFFFF9A8F),
)

private val Light = lightColorScheme(
    primary = Color(0xFF2F5BD8),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFDCE6FF),
    onPrimaryContainer = Color(0xFF0E2257),
    secondaryContainer = Color(0xFFDCE6FF),
    background = Color(0xFFF6F7FA),
    surface = Color(0xFFF6F7FA),
    onSurfaceVariant = Color(0xFF586074),
    surfaceContainerLowest = Color(0xFFEDEFF4),
    surfaceContainerLow = Color(0xFFFFFFFF),
    surfaceContainer = Color(0xFFFFFFFF),
    surfaceContainerHigh = Color(0xFFFFFFFF),
    surfaceContainerHighest = Color(0xFFE3E7EF),
    outline = Color(0xFFC9CFDB),
    outlineVariant = Color(0xFFDDE1E9),
    error = Color(0xFFC62828),
)

private val HakobuType = Typography().let { t ->
    t.copy(
        headlineMedium = t.headlineMedium.copy(fontWeight = FontWeight.Bold, fontSize = 30.sp, letterSpacing = (-0.5).sp),
        headlineSmall = t.headlineSmall.copy(fontWeight = FontWeight.Bold, fontSize = 24.sp),
        titleMedium = t.titleMedium.copy(fontWeight = FontWeight.Medium),
        labelLarge = t.labelLarge.copy(fontWeight = FontWeight.Medium),
    )
}

private val HakobuShapes = Shapes(
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(18.dp),
    large = RoundedCornerShape(22.dp),
)

@Composable
fun HakobuTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) Dark else Light,
        typography = HakobuType,
        shapes = HakobuShapes,
        content = content,
    )
}

/** Small secondary text. */
val MutedSmall: TextStyle @Composable get() = MaterialTheme.typography.bodySmall.copy(color = MaterialTheme.colorScheme.onSurfaceVariant)
