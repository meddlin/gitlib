import { useEffect, useId, useState } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { getCloneDirectory, saveCloneDirectory } from "#/server/catalog";

/** Settings for where "Clone locally" puts repositories. */
export function CloneDirectorySettings() {
  const inputId = useId();
  const [directory, setDirectory] = useState("");
  const [roots, setRoots] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getCloneDirectory()
      .then((current) => {
        setDirectory(current.directory);
        setRoots(current.roots);
      })
      .catch(() => setError("Could not read the current clone directory."));
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await saveCloneDirectory({ data: { directory } });
      if (!result.ok) setError(result.error);
      else {
        setDirectory(result.directory);
        setSaved(true);
      }
    } catch {
      setError("Could not save. See the server log.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="clone-directory-heading" className="flex flex-col gap-4">
      <div>
        <h2 id="clone-directory-heading" className="text-lg font-medium">
          Clone directory
        </h2>
        <p className="text-sm text-muted-foreground">
          Where "Clone locally" puts repositories that are only on GitHub or GitLab. Saved on the server, so it applies in every browser.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={inputId}>Directory</Label>
        <Input
          id={inputId}
          value={directory}
          placeholder="~/git"
          onChange={(event) => {
            setDirectory(event.target.value);
            setSaved(false);
          }}
          autoComplete="off"
          spellCheck={false}
        />
        <p className="text-xs text-muted-foreground">
          Must be inside a scanned root{roots.length > 0 ? ` (${roots.join(", ")})` : ""}, so the clone shows up in your library.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Button type="button" onClick={save} disabled={saving || !directory.trim()}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {saved ? <span className="text-sm text-muted-foreground">Saved.</span> : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
