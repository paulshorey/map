import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard';

const config: CapacitorConfig = {
  appId: 'com.poimap.app',
  appName: 'POI Map',
  webDir: 'out',
  ios: {
    contentInset: 'always',
    backgroundColor: '#f9fafb',
  },
  android: {
    backgroundColor: '#f9fafb',
  },
  server: {
    androidScheme: 'https',
    // Uncomment for live reload against the Next.js dev server:
    // url: 'http://YOUR_LOCAL_IP:3000',
    // cleartext: true,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 0,
      launchAutoHide: false,
      backgroundColor: '#f9fafb',
      showSpinner: false,
    },
    StatusBar: {
      style: 'LIGHT',
      backgroundColor: '#f9fafb',
    },
    Keyboard: {
      resize: KeyboardResize.Body,
      resizeOnFullScreen: true,
    },
  },
};

export default config;
