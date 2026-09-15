'use client'

import dynamic from 'next/dynamic'

const CatalystPit = dynamic(
  () => import('../components/CatalystPit'),
  { ssr: false }
)

export default function HomeClient() {
  return <CatalystPit />
}
