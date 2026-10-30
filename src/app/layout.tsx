import type { Metadata, Viewport } from "next";
import Script from "next/script";

import { GoogleAdsProvider } from "@/components/google-ads-provider";
import { LeadSourceFlag } from "@/components/lead-source-flag";
import { RecaptchaProvider } from "@/components/recaptcha-provider";
import { PageViewTracker } from "@/components/page-view-tracker";
import { ScrollTracker } from "@/components/scroll-tracker";
import { TrackingProvider } from "@/components/tracking-provider";

import "./globals.css";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://care.portea.com";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  verification: {
    // One token per Search Console property. Old tokens stay: removing one
    // unverifies whichever property it belongs to.
    google: [
      "z6GI8J7yo0kQhEAFqZoIT4Q_lyF6z9-7hSwkcZ6f-ow",
      "W7r5t5ppEARDYxRvPwJ_nDppiHIv0bL7qn56Hxq2Za0",
    ],
  },
  title: {
    default: "Portea Managed Elder Care | Doctor-Designed Home Care in India",
    template: "%s | Portea",
  },
  description:
    "Doctor-designed managed home care for elders, dementia and post-hospital recovery. One care manager per family, trained caregivers, weekly updates. 135+ cities.",
  keywords: [
    "elder care at home",
    "dementia care India",
    "post discharge care",
    "home healthcare",
    "Portea",
    "care manager",
    "managed elder care",
    "home nurse",
    "caregiver for elderly",
    "Alzheimer's home care",
  ],
  applicationName: "Portea Care",
  authors: [{ name: "Portea Medical" }],
  creator: "Portea Medical",
  publisher: "Portea Medical",
  category: "healthcare",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    locale: "en_IN",
    url: SITE_URL,
    siteName: "Portea",
    title: "Portea Managed Elder Care | Doctor-Designed Home Care in India",
    description:
      "Doctor-designed home care for elders, dementia, and post-hospital recovery. One care manager, trained caregivers, weekly updates.",
    images: [
      {
        url: "/elder-care-1.webp",
        width: 1200,
        height: 630,
        alt: "Portea caregiver helping an elder at home",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Portea Managed Elder Care",
    description:
      "Doctor-designed home care for elders, dementia, and post-hospital recovery.",
    images: ["/elder-care-1.webp"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
};

export const viewport: Viewport = {
  themeColor: "#ff5b2e",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

const organizationLd = {
  "@context": "https://schema.org",
  "@type": "MedicalBusiness",
  name: "Portea Medical",
  url: SITE_URL,
  logo: `${SITE_URL}/portea-logo.svg`,
  description:
    "Portea provides doctor-designed managed home care for elders, dementia patients, and post-discharge recovery across India.",
  telephone: "+91 91871 16003",
  areaServed: "IN",
  medicalSpecialty: ["Geriatrics", "Home Care", "Rehabilitation"],
  sameAs: ["https://www.portea.com"],
  address: {
    "@type": "PostalAddress",
    addressCountry: "IN",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en-IN">
      <body>
        <GoogleAdsProvider />
        <RecaptchaProvider />
        <LeadSourceFlag />
        <TrackingProvider />
        <PageViewTracker />
        <ScrollTracker />
        {children}
        <Script
          id="ld-organization"
          type="application/ld+json"
          strategy="afterInteractive"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationLd) }}
        />
      </body>
    </html>
  );
}
