import { useEffect, useState } from "react";

const PHONE_QUERY = "(max-width: 720px)";

export function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.(PHONE_QUERY).matches
  );
  useEffect(() => {
    const media = window.matchMedia?.(PHONE_QUERY);
    if (!media) return;
    const sync = () => setPhone(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return phone;
}
