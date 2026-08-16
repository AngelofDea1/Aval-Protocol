"use client";

import Image from "next/image";
import type { WalletOption } from "@/lib/wallet";

/**
 * Shown only when more than one wallet is installed.
 *
 * With one wallet there is nothing to ask, so asking would be friction for its own sake. With
 * two, guessing is worse: the user ends up connected as an address they did not pick.
 */
export function WalletPicker({
  wallets,
  onPick,
  onCancel,
}: {
  wallets: WalletOption[];
  onPick: (w: WalletOption) => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-background/80 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-border bg-popover p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-display text-lg mb-1">Choose a wallet</h3>
        <p className="text-[13px] text-muted-foreground leading-relaxed mb-4">
          You have more than one installed. Aval runs on X Layer, so OKX Wallet already knows
          the network.
        </p>

        <div className="space-y-2">
          {wallets.map((w) => (
            <button
              key={w.rdns}
              onClick={() => onPick(w)}
              className="w-full flex items-center gap-3 rounded-xl border border-border bg-surface p-3 text-left transition-colors hover:bg-surface-2 hover:border-muted-foreground/40"
            >
              {/* Wallet icons are data URIs from the announcement, so no remote host to allow. */}
              {w.icon?.startsWith("data:") ? (
                <Image src={w.icon} alt="" width={28} height={28} className="rounded-md shrink-0" unoptimized />
              ) : (
                <span className="w-7 h-7 rounded-md bg-secondary shrink-0" />
              )}
              <span className="text-[15px]">{w.name}</span>
            </button>
          ))}
        </div>

        <button
          onClick={onCancel}
          className="mt-4 w-full text-[13px] text-muted-foreground hover:text-foreground transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
