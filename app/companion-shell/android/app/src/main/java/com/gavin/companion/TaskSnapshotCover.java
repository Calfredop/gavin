package com.gavin.companion;

import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.view.View;
import android.view.ViewGroup;

/**
 * Keeps Workstation content out of the OS Recents task snapshot.
 *
 * <p>On API 33+ {@link Activity#setRecentsScreenshotEnabled(false)} is enough.
 * Below that (minSdk 30) the only system opt-out is {@code FLAG_SECURE}, which
 * also blocks the owner's screenshots and {@code scripts/device-drive.sh}
 * captures — so those levels draw an opaque cover in {@code onPause} instead
 * (see the card Comments).
 */
final class TaskSnapshotCover {
    private static final int COVER_ID = 0x6a766e63; // 'jvnc'

    private TaskSnapshotCover() {}

    /** Call from {@code onCreate} after the window exists. */
    static void install(Activity activity) {
        if (Build.VERSION.SDK_INT >= 33) {
            activity.setRecentsScreenshotEnabled(false);
        }
    }

    /** API 30–32: cover before the system takes the Recents frame. */
    static void onPause(Activity activity) {
        if (Build.VERSION.SDK_INT >= 33) return;
        ViewGroup root = activity.findViewById(android.R.id.content);
        if (root == null || root.findViewById(COVER_ID) != null) return;
        View cover = new View(activity);
        cover.setId(COVER_ID);
        cover.setBackgroundColor(Color.WHITE);
        cover.setClickable(true);
        root.addView(
            cover,
            new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    static void onResume(Activity activity) {
        if (Build.VERSION.SDK_INT >= 33) return;
        ViewGroup root = activity.findViewById(android.R.id.content);
        if (root == null) return;
        View cover = root.findViewById(COVER_ID);
        if (cover != null) root.removeView(cover);
    }
}
