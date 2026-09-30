"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Loader2, Music, Network, Server, Zap } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type SettingsDTO } from "./types";

interface SettingsResponse {
  ok: boolean;
}

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

async function fetchSettings(): Promise<SettingsDTO> {
  const res = await fetch("/api/settings");
  if (!res.ok) throw new Error("Could not load settings.");
  return (await res.json()) as SettingsDTO;
}

async function putSettings(
  body: Record<string, string | null | undefined>,
): Promise<SettingsResponse> {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as
    | SettingsResponse
    | { error?: string }
    | null;
  if (!res.ok) {
    throw new Error(
      data && "error" in data && data.error ? data.error : "Could not save settings.",
    );
  }
  return data as SettingsResponse;
}

/**
 * Relay-only settings form. Lives inside the DialogContent, so Radix unmounts
 * it (resetting all local edits) whenever the dialog closes.
 */
function RelaySettingsForm({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();

  const { data: settings } = useQuery<SettingsDTO>({
    queryKey: ["settings"],
    queryFn: fetchSettings,
    staleTime: 15_000,
  });

  // Local edits overlay the server values: undefined = untouched (shows /
  // keeps the server value), string = user-modified (empty string = cleared).
  const [edits, setEdits] = useState<{
    url?: string;
    secret?: string;
    baseUrl?: string;
    fireprox?: string;
    provider?: "boppy" | "ace";
    aceToken?: string;
  }>({});
  const [showSecret, setShowSecret] = useState(false);
  const [showAceToken, setShowAceToken] = useState(false);

  const relayUrl = edits.url ?? settings?.relayUrl ?? "";
  const relaySecret = edits.secret ?? "";
  const apiBaseUrl = edits.baseUrl ?? settings?.apiBaseUrl ?? "";
  const fireproxUrl = edits.fireprox ?? settings?.fireproxUrl ?? "";
  const provider = edits.provider ?? settings?.provider ?? "boppy";
  const aceToken = edits.aceToken ?? "";

  const saveMutation = useMutation<SettingsResponse, Error, void>({
    mutationFn: () => {
      const body: {
        relayUrl: string | null;
        relaySecret?: string;
        apiBaseUrl: string | null;
        fireproxUrl: string | null;
        provider: "boppy" | "ace";
        aceToken?: string;
      } = {
        relayUrl: relayUrl.trim() || null,
        apiBaseUrl: apiBaseUrl.trim() || null,
        fireproxUrl: fireproxUrl.trim() || null,
        provider,
      };
      const trimmedSecret = relaySecret.trim();
      // Empty secret field = keep the existing secret (undefined is dropped on serialize).
      if (trimmedSecret) body.relaySecret = trimmedSecret;
      const trimmedAceToken = aceToken.trim();
      // Empty ACE token field = keep (only set if user typed a non-empty value).
      if (trimmedAceToken) body.aceToken = trimmedAceToken;
      return putSettings(body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      toast.success("Settings saved");
      onOpenChange(false);
    },
    onError: (err) => toast.error(err.message),
  });

  const clearRelayMutation = useMutation<SettingsResponse, Error, void>({
    mutationFn: () => putSettings({ relayUrl: null, relaySecret: null }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      setEdits({});
      toast.success("Relay cleared");
    },
    onError: (err) => toast.error(err.message),
  });

  const clearAceTokenMutation = useMutation<SettingsResponse, Error, void>({
    mutationFn: () => putSettings({ aceToken: null }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      setEdits((prev) => ({ ...prev, aceToken: "" }));
      toast.success("ACE token cleared");
    },
    onError: (err) => toast.error(err.message),
  });

  const saving = saveMutation.isPending;
  const clearing = clearRelayMutation.isPending;
  const clearingAce = clearAceTokenMutation.isPending;
  const relayConfigured = Boolean(settings?.relayUrl || settings?.hasRelaySecret);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Connection</DialogTitle>
        <DialogDescription className="text-xs text-zinc-500">
          boppy.me needs no credentials. The relay
          (mini-services/treblo-relay) is only needed if your hosting IP gets
          blocked — run it on a trusted IP and point this URL at it. All API
          calls will then be forwarded through it.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        {/* Provider toggle: boppy (default, public) / ace (acemusic.ai, requires Bearer token) */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Music className="size-4 text-amber-500" aria-hidden />
            <Label className="text-zinc-200">Provider</Label>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setEdits((prev) => ({ ...prev, provider: "boppy" }))}
              className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                provider === "boppy"
                  ? "border-amber-500 bg-amber-500/10 text-amber-300"
                  : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
              }`}
            >
              boppy.me <span className="ml-1 text-xs opacity-60">(public, no auth)</span>
            </button>
            <button
              type="button"
              onClick={() => setEdits((prev) => ({ ...prev, provider: "ace" }))}
              className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                provider === "ace"
                  ? "border-amber-500 bg-amber-500/10 text-amber-300"
                  : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
              }`}
            >
              acemusic.ai <span className="ml-1 text-xs opacity-60">(Bearer token)</span>
            </button>
          </div>
          {provider === "ace" && !settings?.hasAceToken && !aceToken.trim() && (
            <p className="text-xs text-amber-400">
              ⚠️ Set your ACE Bearer token below — without it, ACE requests will fail.
            </p>
          )}
        </div>

        {/* ACE Bearer Token (only shown when provider=ace) */}
        {provider === "ace" && (
          <div className="space-y-2 border-t border-zinc-800 pt-4">
            <div className="flex items-center gap-2">
              <Label htmlFor="settings-ace-token" className="text-zinc-200">
                ACE Bearer Token
              </Label>
              {settings?.hasAceToken && !aceToken.trim() && (
                <span className="ml-auto text-xs text-emerald-400">token set</span>
              )}
            </div>
            <div className="relative">
              <Input
                id="settings-ace-token"
                type={showAceToken ? "text" : "password"}
                value={aceToken}
                onChange={(e) =>
                  setEdits((prev) => ({ ...prev, aceToken: e.target.value }))
                }
                placeholder={
                  settings?.hasAceToken
                    ? "Leave empty to keep current token"
                    : "Paste your acemusic.ai Bearer token"
                }
                autoComplete="off"
                spellCheck={false}
                className="border-zinc-800 bg-zinc-950 pr-10 text-zinc-100 placeholder:text-zinc-600"
              />
              <button
                type="button"
                onClick={() => setShowAceToken((v) => !v)}
                aria-label={showAceToken ? "Hide ACE token" : "Show ACE token"}
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
              >
                {showAceToken ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
              </button>
            </div>
            {settings?.hasAceToken && (
              <button
                type="button"
                onClick={() => clearAceTokenMutation.mutate()}
                disabled={clearingAce || saving}
                className="text-xs text-zinc-500 transition-colors hover:text-red-400 disabled:opacity-50"
              >
                {clearingAce && <Loader2 className="inline size-3 animate-spin" aria-hidden />} Clear ACE token
              </button>
            )}
            <p className="text-xs text-zinc-500">
              Get your Bearer token from acemusic.ai DevTools → Network → any request to
              acem-api.acemusic.ai → Authorization header. The token is stored in the
              local DB only (never in source code, never sent to the client).
            </p>
          </div>
        )}

        {/* Relay URL */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Network className="size-4 text-amber-500" aria-hidden />
            <Label htmlFor="settings-relay-url" className="text-zinc-200">
              Relay URL
            </Label>
            {settings?.relayUrl && (
              <span className="ml-auto text-xs text-emerald-400">active</span>
            )}
          </div>
          <Input
            id="settings-relay-url"
            value={relayUrl}
            onChange={(e) => setEdits((prev) => ({ ...prev, url: e.target.value }))}
            placeholder="https://relay.example.com"
            autoComplete="off"
            spellCheck={false}
            className="border-zinc-800 bg-zinc-950 text-zinc-100 placeholder:text-zinc-600"
          />
        </div>

        {/* Relay secret */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Label htmlFor="settings-relay-secret" className="text-zinc-200">
              Relay secret <span className="text-zinc-500">(x-relay-secret)</span>
            </Label>
            {settings?.hasRelaySecret && (
              <span className="ml-auto text-xs text-emerald-400">
                secret set
              </span>
            )}
          </div>
          <div className="relative">
            <Input
              id="settings-relay-secret"
              type={showSecret ? "text" : "password"}
              value={relaySecret}
              onChange={(e) =>
                setEdits((prev) => ({ ...prev, secret: e.target.value }))
              }
              placeholder={
                settings?.hasRelaySecret
                  ? "Leave empty to keep current secret"
                  : "Only if the relay requires one"
              }
              autoComplete="off"
              spellCheck={false}
              className="border-zinc-800 bg-zinc-950 pr-10 text-zinc-100 placeholder:text-zinc-600"
            />
            <button
              type="button"
              onClick={() => setShowSecret((v) => !v)}
              aria-label={showSecret ? "Hide relay secret" : "Show relay secret"}
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            >
              {showSecret ? (
                <EyeOff className="size-4" aria-hidden />
              ) : (
                <Eye className="size-4" aria-hidden />
              )}
            </button>
          </div>
        </div>

        {/* API endpoint (advanced — self-hosted ACE-Step) */}
        <div className="space-y-2 border-t border-zinc-800 pt-4">
          <div className="flex items-center gap-2">
            <Server className="size-4 text-amber-500" aria-hidden />
            <Label htmlFor="settings-api-base" className="text-zinc-200">
              API endpoint <span className="text-zinc-500">(advanced)</span>
            </Label>
          </div>
          <Input
            id="settings-api-base"
            value={apiBaseUrl}
            onChange={(e) => setEdits((prev) => ({ ...prev, baseUrl: e.target.value }))}
            placeholder="https://boppy.me"
            autoComplete="off"
            spellCheck={false}
            className="border-zinc-800 bg-zinc-950 text-zinc-100 placeholder:text-zinc-600"
          />
          <p className="text-xs text-zinc-500">
            Leave empty to use boppy.me. Point it at your own ACE-Step-compatible
            deployment (self-hosted = no rate limits) to lift the burst/daily caps.
          </p>
        </div>

        {/* FireProx (advanced — AWS API Gateway IP rotation) */}
        <div className="space-y-2 border-t border-zinc-800 pt-4">
          <div className="flex items-center gap-2">
            <Zap className="size-4 text-amber-500" aria-hidden />
            <Label htmlFor="settings-fireprox" className="text-zinc-200">
              FireProx URL <span className="text-zinc-500">(advanced)</span>
            </Label>
            {settings?.fireproxUrl && (
              <span className="ml-auto text-xs text-emerald-400">active</span>
            )}
          </div>
          <Input
            id="settings-fireprox"
            value={fireproxUrl}
            onChange={(e) => setEdits((prev) => ({ ...prev, fireprox: e.target.value }))}
            placeholder="AWS: ...amazonaws.com/fireprox | ScraperAPI: api.scraperapi.com?api_key=KEY | Oxylabs: customer-USER:PASS@pr.oxylabs.io:7777 | TorProxy: http://127.0.0.1:8790"
            autoComplete="off"
            spellCheck={false}
            className="border-zinc-800 bg-zinc-950 text-zinc-100 placeholder:text-zinc-600"
          />
          <p className="text-xs text-zinc-500">
            Per-request IP rotation endpoint. Auto-detects four formats:<br />
            • <strong>AWS FireProx</strong>: <code>...amazonaws.com/fireprox</code> — ~12k IPs/region, 1M req/mo free.<br />
            • <strong>ScraperAPI</strong>: <code>api.scraperapi.com?api_key=...</code> — residential IPs, 5000 req/mo free.<br />
            • <strong>Oxylabs residential</strong>: <code>http://customer-USER:PASS@pr.oxylabs.io:7777</code> — millions of ISP IPs, very high trust (boppy won't block), 7-day free trial →{" "}
            <a href="https://dashboard.oxylabs.io/en/" target="_blank" rel="noreferrer" className="underline hover:text-zinc-300">
              dashboard.oxylabs.io
            </a>
            .<br />
            • <strong>TorProxy / HTTP proxy</strong>: <code>http://127.0.0.1:8790</code> — Tor exit IP per request (free, ~1.1k IPs but boppy blocks Tor after 3). See{" "}
            <a href="https://github.com/dp2008/tor_proxy" target="_blank" rel="noreferrer" className="underline hover:text-zinc-300">
              tor_proxy
            </a>
            .<br />
            All spoof <code>X-Forwarded-For</code> per request. Takes precedence over the relay when set.
          </p>
        </div>
      </div>

      <DialogFooter className="gap-2">
        <Button
          variant="outline"
          onClick={() => clearRelayMutation.mutate()}
          disabled={clearing || saving || !relayConfigured}
          className="border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100"
        >
          {clearing && <Loader2 className="animate-spin" aria-hidden />}
          Clear relay
        </Button>
        <Button
          onClick={() => saveMutation.mutate()}
          disabled={saving || clearing}
          className="bg-amber-500 font-semibold text-zinc-950 hover:bg-amber-600"
        >
          {saving && <Loader2 className="animate-spin" aria-hidden />}
          Save
        </Button>
      </DialogFooter>
    </>
  );
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="custom-scrollbar max-h-[85vh] overflow-y-auto border-zinc-800/80 bg-zinc-900 text-zinc-100">
        {/* Mounted only while open — Radix unmounts it on close, resetting edits. */}
        <RelaySettingsForm onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}
