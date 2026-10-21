import { Navigate, useLocation } from "react-router";
import { webRoutePath } from "./app-route-metadata";

export function HomeRedirect() {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: webRoutePath("today"), search, hash }} replace />;
}
