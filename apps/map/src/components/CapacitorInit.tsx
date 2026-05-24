'use client';

import { useEffect } from 'react';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';
import { Keyboard, KeyboardResize } from '@capacitor/keyboard';
import { platform } from '@/lib/platform/detect';

export function CapacitorInit() {
  useEffect(() => {
    if (!platform.isNative) return;

    void (async () => {
      try {
        await StatusBar.setStyle({ style: Style.Light });
        await Keyboard.setResizeMode({ mode: KeyboardResize.Body });
        await SplashScreen.hide({ fadeOutDuration: 300 });
      } catch {
        // Native plugins are unavailable outside Capacitor shells.
      }
    })();
  }, []);

  return null;
}
