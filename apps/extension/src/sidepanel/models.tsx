import type { Api, Model } from "@earendil-works/pi-ai";

import { SelectGroup, SelectItem, SelectLabel } from "@/components/ui/select";

import type { RelayApp } from "../core/app.ts";

type ModelRef = { provider: string; id: string };

/** A model's value in a model select. */
export function modelKey(model: ModelRef): string {
  return `${model.provider}/${model.id}`;
}

/** The model a `modelKey` value names. Model ids may contain slashes; the provider id never does. */
export function parseModelKey(value: string | null): ModelRef | undefined {
  const [provider, ...rest] = (value ?? "").split("/");
  return provider && rest.length > 0 ? { provider, id: rest.join("/") } : undefined;
}

/** `selected`, if it is one of `models`. */
export function findModel(
  models: readonly Model<Api>[],
  selected: ModelRef | undefined,
): Model<Api> | undefined {
  return selected && models.find((model) => modelKey(model) === modelKey(selected));
}

/** `models` as select options, grouped by the provider serving them. */
export function ModelOptions({ app, models }: { app: RelayApp; models: readonly Model<Api>[] }) {
  return [...Map.groupBy(models, (model) => model.provider)].map(([providerId, list]) => (
    <SelectGroup key={providerId}>
      <SelectLabel>{app.models.getProvider(providerId)?.name ?? providerId}</SelectLabel>
      {list.map((model) => (
        <SelectItem key={modelKey(model)} value={modelKey(model)}>
          {model.name}
        </SelectItem>
      ))}
    </SelectGroup>
  ));
}
