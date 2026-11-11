import type SignClient from '@walletconnect/sign-client';

/** SDK 2.26 acknowledged() returns its local store before the peer confirms settlement. */
export async function waitForSessionAcknowledgement(client: SignClient, topic: string, current: () => boolean) {
  const deadline = Date.now() + 30000;
  while (current()) {
    const session = client.session.get(topic);
    if (session.acknowledged) return session;
    if (Date.now() >= deadline) throw new Error('dApp 尚未确认连接，请在 Safe 重新生成二维码后重试');
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('连接已取消');
}
