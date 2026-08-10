import "./globals.css";

export const metadata = {
  title: "Global Signal Monitor",
  description: "Monthly company signal monitoring dashboard",
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
