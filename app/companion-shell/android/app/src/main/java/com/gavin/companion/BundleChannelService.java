package com.gavin.companion;

import android.app.Service;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;

import androidx.annotation.NonNull;

/**
 * Where the bundle's process reaches the shell's. Bound by
 * {@link BundleActivity}; not exported, so nothing outside this app can
 * bind it. Every message is handed to {@link BundleChannel}.
 *
 * <p>The binding also keeps the shell's process at the bundle's priority
 * while the bundle is in front, so its end of the channel keeps running.
 */
public class BundleChannelService extends Service {
    private final Messenger messenger = new Messenger(new Handler(Looper.getMainLooper()) {
        @Override
        public void handleMessage(@NonNull Message message) {
            Bundle data = message.getData();
            int session = data.getInt(BundleChannel.SESSION);
            switch (message.what) {
                case BundleChannel.HELLO:
                    BundleChannel.hello(session, message.replyTo);
                    break;
                case BundleChannel.FROM_BUNDLE:
                    BundleChannel.fromBundle(
                        session, data.getString(BundleChannel.ORIGIN, ""), data.getString(BundleChannel.DATA, ""));
                    break;
                case BundleChannel.DROPPED:
                    BundleChannel.dropped(
                        session, data.getString(BundleChannel.ORIGIN, ""), data.getBoolean(BundleChannel.MAIN_FRAME));
                    break;
                case BundleChannel.CLOSED:
                    BundleChannel.closed(session);
                    break;
                default:
                    super.handleMessage(message);
            }
        }
    });

    @Override
    public IBinder onBind(Intent intent) {
        return messenger.getBinder();
    }
}
