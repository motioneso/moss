import { Smartphone } from "lucide-react";

/** The Android app's web view adds this marker to its user agent. A browser never has it. */
export const MOSS_ANDROID_MARKER = "MossAndroid/";

/** The only address the app intercepts. It opens the native Hardware page. */
export const MOSS_ANDROID_HARDWARE_URL = "moss-android://hardware";

export function isMossAndroid(userAgent: string): boolean {
  return userAgent.includes(MOSS_ANDROID_MARKER);
}

/** A Settings entry that exists only inside the Android app. It opens no pane of its own. */
export function HardwareNavLink({ userAgent }: { userAgent: string }) {
  if (!isMossAndroid(userAgent)) return null;
  return (
    <a className="set2__navitem" href={MOSS_ANDROID_HARDWARE_URL}>
      <span className="ic">
        <Smartphone size={17} aria-hidden="true" />
      </span>
      <span className="lbl">Hardware</span>
    </a>
  );
}
