"use client";

import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";

const SAFE_FAILURE_MESSAGE = "No se pudo actualizar la configuración. Inténtalo nuevamente.";
const METADATA_FAILURE_MESSAGE = "No se pudo consultar la configuración. Inténtalo nuevamente.";

interface CredentialMetadata {
  bankCode: string;
  isActive: boolean;
  keyVersion: number;
  lastRotatedAt: string | null;
  autoLoginEnabled: boolean;
}

export type CredentialMetadataState = "loading" | "failed" | "absent" | "present";

export function canSubmitCredentials(state: CredentialMetadataState): boolean {
  return state === "absent" || state === "present";
}

export function credentialActionForMetadata(state: CredentialMetadataState): "set" | "rotate" {
  return state === "present" ? "rotate" : "set";
}

interface BankAutoLoginSettingsProps {
  bankCode: string;
  bankName: string;
  initialAutoLoginEnabled?: boolean;
}

export function BankAutoLoginSettings({
  bankCode,
  bankName,
  initialAutoLoginEnabled = false,
}: BankAutoLoginSettingsProps) {
  const [metadataState, setMetadataState] = useState<CredentialMetadataState>("loading");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isToggling, setIsToggling] = useState(false);
  const [autoLoginEnabled, setAutoLoginEnabled] = useState(initialAutoLoginEnabled);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [statusMessage, setStatusMessage] = useState("Cargando configuración…");

  useEffect(() => {
    let active = true;

    void fetchCredentialMetadata(bankCode, fetch)
      .then((result) => {
        if (!active) return;
        setMetadataState(result ? "present" : "absent");
        if (result) setAutoLoginEnabled(result.autoLoginEnabled);
        setStatusMessage(result ? "Credenciales configuradas." : "No hay credenciales configuradas.");
      })
      .catch(() => {
        if (!active) return;
        setMetadataState("failed");
        setStatusMessage(METADATA_FAILURE_MESSAGE);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [bankCode]);

  async function handleCredentialsSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmitCredentials(metadataState)) return;
    if (!username.trim() || !password) {
      setStatusMessage("Escribe el usuario y la contraseña del banco.");
      return;
    }

    setIsSaving(true);
    try {
      const saved = await saveBankCredentials({
        bankCode,
        action: credentialActionForMetadata(metadataState),
        username,
        password,
        fetchImpl: fetch,
      });
      if (!saved) throw new Error("credential request failed");

      setUsername("");
      setPassword("");
      setMetadataState("present");
      setStatusMessage("Credenciales actualizadas.");
      toast.success("Credenciales actualizadas");
    } catch {
      setStatusMessage(SAFE_FAILURE_MESSAGE);
      toast.error(SAFE_FAILURE_MESSAGE);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleAutoLoginToggle() {
    const nextEnabled = !autoLoginEnabled;
    setIsToggling(true);
    try {
      const updated = await toggleAutoLogin({ bankCode, enabled: nextEnabled, fetchImpl: fetch });
      if (!updated) throw new Error("toggle request failed");

      setAutoLoginEnabled(nextEnabled);
      const message = nextEnabled ? "Auto-login activado" : "Auto-login desactivado";
      setStatusMessage(message);
      toast.success(message);
    } catch {
      setStatusMessage(SAFE_FAILURE_MESSAGE);
      toast.error(SAFE_FAILURE_MESSAGE);
    } finally {
      setIsToggling(false);
    }
  }

  return (
    <Card variant="outlined" aria-label={`Configuración de auto-login de ${bankName}`}>
      <CardHeader>
        <CardTitle>Configuración de auto-login</CardTitle>
        <CardDescription>
          Administra las credenciales institucionales de {bankName}. Nunca se muestran después de guardarlas.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {isLoading ? "Cargando configuración…" : statusMessage}
        </p>

        <form className="grid gap-3" onSubmit={handleCredentialsSubmit}>
          <div className="grid gap-1.5">
            <label htmlFor={`${bankCode}-username`} className="text-sm font-medium">Usuario del banco</label>
            <Input
              id={`${bankCode}-username`}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="off"
              disabled={isSaving}
            />
          </div>
          <div className="grid gap-1.5">
            <label htmlFor={`${bankCode}-password`} className="text-sm font-medium">Contraseña del banco</label>
            <Input
              id={`${bankCode}-password`}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              disabled={isSaving}
            />
          </div>
          <Button type="submit" className="w-fit" disabled={isSaving || !canSubmitCredentials(metadataState)}>
            {isSaving ? "Guardando…" : metadataState === "present" ? "Actualizar credenciales" : "Guardar credenciales"}
          </Button>
        </form>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 p-4">
          <div>
            <p className="text-sm font-medium">Auto-login por sesión vencida</p>
            <p className="text-sm text-muted-foreground">Estado: {autoLoginEnabled ? "Activado" : "Desactivado"}</p>
          </div>
          <Button
            type="button"
            variant={autoLoginEnabled ? "destructive" : "outline"}
            onClick={handleAutoLoginToggle}
            disabled={isToggling}
            aria-pressed={autoLoginEnabled}
            aria-label={`${autoLoginEnabled ? "Desactivar" : "Activar"} auto-login para ${bankName}`}
          >
            {isToggling ? "Actualizando…" : autoLoginEnabled ? "Desactivar auto-login" : "Activar auto-login"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export async function fetchCredentialMetadata(
  bankCode: string,
  fetchImpl: typeof fetch,
): Promise<CredentialMetadata | null> {
  const response = await fetchImpl(`/api/bank-credentials?bankCode=${encodeURIComponent(bankCode)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("metadata request failed");
  return response.json() as Promise<CredentialMetadata>;
}

export async function saveBankCredentials({
  bankCode,
  action,
  username,
  password,
  fetchImpl,
}: {
  bankCode: string;
  action: "set" | "rotate";
  username: string;
  password: string;
  fetchImpl: typeof fetch;
}): Promise<boolean> {
  try {
    const response = await fetchImpl("/api/bank-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, bankCode, username, password }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function toggleAutoLogin({
  bankCode,
  enabled,
  fetchImpl,
}: {
  bankCode: string;
  enabled: boolean;
  fetchImpl: typeof fetch;
}): Promise<boolean> {
  try {
    const response = await fetchImpl(`/api/bank-credentials/${encodeURIComponent(bankCode)}/auto-login`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
