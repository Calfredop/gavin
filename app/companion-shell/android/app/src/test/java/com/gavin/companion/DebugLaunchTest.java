package com.gavin.companion;

import org.junit.Test;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class DebugLaunchTest {
    @Test
    public void ignoresRequestFilesWhenNotDebuggable() throws Exception {
        File files = tempFilesDir();
        writeFlag(files, DebugLaunch.KEYS_CHECK);
        writeFlag(files, DebugLaunch.STRICT_KEYS);
        writeFlag(files, DebugLaunch.BUNDLE_PROBE);
        writeText(files, DebugLaunch.PAIR_CODE, "YmFzZTY0");

        DebugLaunch request = DebugLaunch.consume(files, false);

        assertFalse(request.keysCheck);
        assertFalse(request.strictKeys);
        assertFalse(request.bundleProbe);
        assertFalse(request.openFirst);
        assertNull(request.pairCode);
        assertTrue(new File(new File(files, DebugLaunch.DIR), DebugLaunch.KEYS_CHECK).isFile());
        assertTrue(new File(new File(files, DebugLaunch.DIR), DebugLaunch.PAIR_CODE).isFile());
    }

    @Test
    public void readsEachRequestOnceAndDeletesItsFile() throws Exception {
        File files = tempFilesDir();
        writeFlag(files, DebugLaunch.KEYS_CHECK);
        writeFlag(files, DebugLaunch.STRICT_KEYS);
        writeFlag(files, DebugLaunch.BUNDLE_PROBE);
        writeFlag(files, DebugLaunch.OPEN_FIRST);
        writeText(files, DebugLaunch.PAIR_CODE, "YmFzZTY0\n");

        DebugLaunch first = DebugLaunch.consume(files, true);
        assertTrue(first.keysCheck);
        assertTrue(first.strictKeys);
        assertTrue(first.bundleProbe);
        assertTrue(first.openFirst);
        assertEquals("YmFzZTY0", first.pairCode);

        File dir = new File(files, DebugLaunch.DIR);
        assertFalse(new File(dir, DebugLaunch.KEYS_CHECK).exists());
        assertFalse(new File(dir, DebugLaunch.STRICT_KEYS).exists());
        assertFalse(new File(dir, DebugLaunch.BUNDLE_PROBE).exists());
        assertFalse(new File(dir, DebugLaunch.OPEN_FIRST).exists());
        assertFalse(new File(dir, DebugLaunch.PAIR_CODE).exists());

        DebugLaunch second = DebugLaunch.consume(files, true);
        assertFalse(second.keysCheck);
        assertFalse(second.strictKeys);
        assertFalse(second.bundleProbe);
        assertFalse(second.openFirst);
        assertNull(second.pairCode);
    }

    @Test
    public void requestsNothingWhenNoFiles() throws Exception {
        File files = tempFilesDir();
        DebugLaunch request = DebugLaunch.consume(files, true);
        assertFalse(request.keysCheck);
        assertFalse(request.strictKeys);
        assertFalse(request.bundleProbe);
        assertFalse(request.openFirst);
        assertNull(request.pairCode);
    }

    private static File tempFilesDir() throws IOException {
        return Files.createTempDirectory("gavin-debug-launch").toFile();
    }

    private static void writeFlag(File filesDir, String name) throws IOException {
        File dir = new File(filesDir, DebugLaunch.DIR);
        assertTrue(dir.mkdirs() || dir.isDirectory());
        assertTrue(new File(dir, name).createNewFile());
    }

    private static void writeText(File filesDir, String name, String text) throws IOException {
        File dir = new File(filesDir, DebugLaunch.DIR);
        assertTrue(dir.mkdirs() || dir.isDirectory());
        Files.write(new File(dir, name).toPath(), text.getBytes(StandardCharsets.UTF_8));
    }
}
