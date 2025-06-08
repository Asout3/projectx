import Link from "next/link";

export default function Home() {
  return (
    <div>
      <h2>this web is under development so please wait </h2>
      <Link href="/dash"><button className="border rounded bg-green-500">go</button></Link>
    </div>
  );
}
