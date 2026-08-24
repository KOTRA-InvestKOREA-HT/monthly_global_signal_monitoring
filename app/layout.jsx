import localFont from "next/font/local";
import "./globals.css";

const notoSansKr = localFont({
  src: [
    { path: "../assets/fonts/NotoSansKR-DemiLight.ttf", weight: "350", style: "normal" },
    { path: "../assets/fonts/NotoSansKR-Medium.ttf", weight: "500", style: "normal" },
    { path: "../assets/fonts/NotoSansKR-SemiBold.ttf", weight: "600", style: "normal" },
    { path: "../assets/fonts/NotoSansKR-ExtraBold.ttf", weight: "800", style: "normal" },
  ],
  display: "swap",
});

export const metadata = {
  title: "Global Signal Monitor",
  description: "Monthly company signal monitoring dashboard",
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body className={notoSansKr.className}>{children}</body>
    </html>
  );
}
