import localFont from "next/font/local";
import "./globals.css";

const pretendardJp = localFont({
  src: [
    { path: "../assets/fonts/PretendardJP-Regular.woff2", weight: "400", style: "normal" },
    { path: "../assets/fonts/PretendardJP-Medium.woff2", weight: "500", style: "normal" },
    { path: "../assets/fonts/PretendardJP-SemiBold.woff2", weight: "600", style: "normal" },
    { path: "../assets/fonts/PretendardJP-ExtraBold.woff2", weight: "800", style: "normal" },
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
      <body className={pretendardJp.className}>{children}</body>
    </html>
  );
}
