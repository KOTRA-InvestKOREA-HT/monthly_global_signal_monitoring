import localFont from "next/font/local";
import "./globals.css";

// 화면용은 서브셋 woff2를 쓴다. 원본 TTF 4종은 33.7MB라 처음 접속하는 사람이 그만큼 내려받았다.
// 한글 완성형 전체를 유지했으므로 글자가 빠지지 않는다. 원본 TTF는 PDF 생성이 계속 쓰므로 남겨둔다.
const notoSansKr = localFont({
  src: [
    { path: "../assets/fonts/web/NotoSansKR-DemiLight.woff2", weight: "350", style: "normal" },
    { path: "../assets/fonts/web/NotoSansKR-Medium.woff2", weight: "500", style: "normal" },
    { path: "../assets/fonts/web/NotoSansKR-SemiBold.woff2", weight: "600", style: "normal" },
    { path: "../assets/fonts/web/NotoSansKR-ExtraBold.woff2", weight: "800", style: "normal" },
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
