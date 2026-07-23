import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // API responses and personal team dashboards shouldn't be indexed.
      disallow: ["/api/", "/team/"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
