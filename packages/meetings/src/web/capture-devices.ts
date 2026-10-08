import { useQuery } from "@tanstack/react-query";
import { CaptureRequestError, captureKeys, getCaptureDevices } from "./capture-client.js";

export function useCaptureDevices() {
  return useQuery({
    queryKey: captureKeys.devices,
    queryFn: ({ signal, client }) => {
      const error = client.getQueryState(captureKeys.devices)?.error;
      if (error instanceof CaptureRequestError && error.retryAt > Date.now()) throw error;
      return getCaptureDevices(signal);
    },
    retry: false,
    staleTime: 5000,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      query.state.error instanceof CaptureRequestError
        ? Math.max(5000, query.state.error.retryAt - Date.now())
        : 5000,
    refetchIntervalInBackground: false
  });
}
