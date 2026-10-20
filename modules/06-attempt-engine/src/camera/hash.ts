import { signupHmac } from "@assessiq/tenancy";

/** Keyed HMAC of the IP for camera_consents.ip_hash (never store the IP). */
export function hashCameraIp(ip: string): string {
  return signupHmac("camera-ip", ip);
}
