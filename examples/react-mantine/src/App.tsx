// Everything the agent contract needs from a real screen: a root with data-state, testids on actions,
// portals (modal, select list), hidden inputs (checkbox, chip), a kept-mounted hidden tab with a duplicate testid.
import { Alert, Anchor, Button, Checkbox, Chip, Group, Modal, Select, Tabs, TextInput, Title } from "@mantine/core";
import { QueryClient, useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, createBrowserRouter } from "react-router-dom";

import { registerBusySource, registerDataSource } from "./shared/stalker/busy";
import { queryScreenState, screenFactProps, screenRootProps } from "./shared/stalker/screenState";

export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

type Person = { id: string; name: string; role: string; remote: boolean; level: string };

function AddPerson({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<string | null>(null);
  const [remote, setRemote] = useState(false);
  const [level, setLevel] = useState("junior");
  const save = useMutation({
    mutationFn: async () => {
      const answer = await fetch("/api/people", { method: "POST", body: JSON.stringify({ name, role, remote, level }) });
      if (!answer.ok) throw new Error(`POST /api/people -> ${answer.status}`);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["people"] });
      onClose();
    },
  });
  return (
    <Modal opened={opened} onClose={onClose} title="New person" transitionProps={{ duration: 0 }}>
      <TextInput label="Name" data-testid="people.name" value={name} onChange={(event) => setName(event.currentTarget.value)} />
      <Select label="Role" data-testid="people.role" data={["Engineer", "Designer"]} value={role} onChange={setRole} comboboxProps={{ transitionProps: { duration: 0 } }} />
      <Checkbox label="Remote" data-testid="people.remote" checked={remote} onChange={(event) => setRemote(event.currentTarget.checked)} mt="sm" />
      <Chip.Group value={level} onChange={(value) => setLevel(value as string)}>
        <Group mt="sm">
          <Chip value="junior" data-testid="people.level-junior">Junior</Chip>
          <Chip value="senior" data-testid="people.level-senior">Senior</Chip>
        </Group>
      </Chip.Group>
      {save.isError ? <Alert role="alert" color="red" mt="sm">Not saved</Alert> : null}
      <Button mt="md" data-testid="people.save" disabled={!name || !role} loading={save.isPending} onClick={() => save.mutate()}>
        Save
      </Button>
    </Modal>
  );
}

function PeopleScreen() {
  const [adding, setAdding] = useState(false);
  const people = useQuery({
    queryKey: ["people"],
    queryFn: async (): Promise<Person[]> => {
      const answer = await fetch("/api/people");
      if (!answer.ok) throw new Error(`GET /api/people -> ${answer.status}`);
      return (await answer.json()).items;
    },
  });
  const items = people.data ?? [];
  return (
    <main {...screenRootProps("people", queryScreenState({ status: people.status, isEmpty: !items.length }))}>
      <Title order={1}>People</Title>
      <span {...screenFactProps("count", items.length)} />
      <Anchor component={Link} to="/settings" data-testid="nav.settings">Settings</Anchor>
      <Tabs defaultValue="active" keepMounted>
        <Tabs.List>
          <Tabs.Tab value="active" data-testid="people.tab-active">Active</Tabs.Tab>
          <Tabs.Tab value="archive" data-testid="people.tab-archive">Archive</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="archive">
          <Button data-testid="people.add" onClick={() => setAdding(true)}>Add from archive</Button>
        </Tabs.Panel>
        <Tabs.Panel value="active">
          <Button data-testid="people.add" onClick={() => setAdding(true)}>Add person</Button>
          <ul>
            {items.map((person) => (
              <li key={person.id} data-testid="people.row">{person.name}, {person.role}, {person.level}{person.remote ? ", remote" : ""}</li>
            ))}
          </ul>
        </Tabs.Panel>
      </Tabs>
      <AddPerson opened={adding} onClose={() => setAdding(false)} />
    </main>
  );
}

function SettingsScreen() {
  return (
    <main {...screenRootProps("settings", "ready")}>
      <Title order={1}>Settings</Title>
      <Anchor component={Link} to="/" data-testid="nav.people">People</Anchor>
    </main>
  );
}

export const router = createBrowserRouter([
  { path: "/", element: <PeopleScreen /> },
  { path: "/settings", element: <SettingsScreen /> },
]);

// Background refetches with data already present are not "busy": a polling page must still settle.
registerBusySource("queries", () => queryClient.getQueryCache().findAll({ fetchStatus: "fetching", predicate: (query) => query.state.data === undefined }).length);
registerBusySource("mutations", () => queryClient.isMutating());
registerBusySource("navigation", () => (router.state.navigation.state === "idle" ? 0 : 1));
// The data layer: which requests a screen shows and how they ended, how saves ended. The executor checks it under --sensors.
registerDataSource("queries", () =>
  queryClient.getQueryCache().getAll().map((query) => ({
    key: JSON.stringify(query.queryKey),
    status: query.state.status,
    observers: query.getObserversCount(),
    updatedAt: query.state.dataUpdatedAt,
    ...(query.state.error ? { error: String((query.state.error as Error).message) } : {}),
  })),
);
registerDataSource("mutations", () =>
  queryClient.getMutationCache().getAll().map((mutation) => ({
    status: mutation.state.status,
    submittedAt: mutation.state.submittedAt,
    ...(mutation.state.error ? { error: String((mutation.state.error as Error).message) } : {}),
  })),
);
