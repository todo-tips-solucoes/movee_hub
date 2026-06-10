"use client"

import * as React from "react"
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"
import { SearchIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Command / CommandMenu — interface shadcn-compatível implementada sobre
 * @base-ui/react/combobox. Exporta as mesmas named exports que shadcn/ui
 * `command` para que os consumidores (EmpresaSelector, etc.) possam usar:
 *   import { Command, CommandInput, CommandList, CommandItem, ... }
 *     from "@/components/ui/command"
 *
 * Nota arquitetural: ComboboxRoot não renderiza HTML próprio (context-only).
 * O container visual é um div wrapper; o Root é passado via `comboboxProps`.
 */

// Props para o Command container: combina props visuais do div + props
// de estado do ComboboxRoot (value, onValueChange, etc.)
type CommandProps<Value = string> = ComboboxPrimitive.Root.Props<Value> &
  Omit<React.HTMLAttributes<HTMLDivElement>, "children"> & {
    children?: React.ReactNode
  }

function Command<Value = string>({
  className,
  children,
  // Extrair props do ComboboxRoot para não passar ao div
  value,
  onValueChange,
  defaultValue,
  items,
  inputValue,
  onInputValueChange,
  open,
  onOpenChange,
  defaultOpen,
  autoHighlight,
  highlightItemOnHover,
  itemToStringLabel,
  itemToStringValue,
  isItemEqualToValue,
  name,
  id,
  required,
  readOnly,
  disabled,
  multiple,
  autoComplete,
  ...divProps
}: CommandProps<Value>) {
  const rootProps: ComboboxPrimitive.Root.Props<Value> = {
    value,
    onValueChange,
    defaultValue,
    items,
    inputValue,
    onInputValueChange,
    open,
    onOpenChange,
    defaultOpen,
    autoHighlight,
    highlightItemOnHover,
    itemToStringLabel,
    itemToStringValue,
    isItemEqualToValue,
    name,
    id,
    required,
    readOnly,
    disabled,
    multiple,
    autoComplete,
  } as ComboboxPrimitive.Root.Props<Value>

  return (
    <ComboboxPrimitive.Root {...rootProps}>
      <div
        data-slot="command"
        className={cn(
          "flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground",
          className
        )}
        {...divProps}
      >
        {children}
      </div>
    </ComboboxPrimitive.Root>
  )
}

function CommandInput({
  className,
  ...props
}: ComboboxPrimitive.Input.Props & { className?: string }) {
  return (
    <div
      data-slot="command-input-wrapper"
      className="flex items-center border-b border-border px-3"
    >
      <SearchIcon className="mr-2 size-4 shrink-0 opacity-50" />
      <ComboboxPrimitive.Input
        data-slot="command-input"
        className={cn(
          "flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      />
    </div>
  )
}

function CommandList({
  className,
  children,
  ...props
}: ComboboxPrimitive.List.Props & { className?: string }) {
  return (
    <ComboboxPrimitive.List
      data-slot="command-list"
      className={cn(
        "max-h-[300px] overflow-y-auto overflow-x-hidden",
        className
      )}
      {...props}
    >
      {children}
    </ComboboxPrimitive.List>
  )
}

function CommandEmpty({
  className,
  children = "Nenhum resultado encontrado.",
  ...props
}: ComboboxPrimitive.Empty.Props & { className?: string }) {
  return (
    <ComboboxPrimitive.Empty
      data-slot="command-empty"
      className={cn("py-6 text-center text-sm text-muted-foreground", className)}
      {...props}
    >
      {children}
    </ComboboxPrimitive.Empty>
  )
}

function CommandGroup({
  className,
  heading,
  children,
  ...props
}: ComboboxPrimitive.Group.Props & { heading?: React.ReactNode; className?: string }) {
  return (
    <ComboboxPrimitive.Group
      data-slot="command-group"
      className={cn("overflow-hidden p-1 text-foreground", className)}
      {...props}
    >
      {heading && (
        <ComboboxPrimitive.GroupLabel
          data-slot="command-group-heading"
          className="px-2 py-1.5 text-xs font-medium text-muted-foreground"
        >
          {heading}
        </ComboboxPrimitive.GroupLabel>
      )}
      {children}
    </ComboboxPrimitive.Group>
  )
}

function CommandSeparator({
  className,
  ...props
}: React.HTMLAttributes<HTMLHRElement>) {
  return (
    <hr
      data-slot="command-separator"
      className={cn("-mx-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function CommandItem({
  className,
  children,
  ...props
}: ComboboxPrimitive.Item.Props & { className?: string }) {
  return (
    <ComboboxPrimitive.Item
      data-slot="command-item"
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none",
        "data-highlighted:bg-accent data-highlighted:text-accent-foreground",
        "data-disabled:pointer-events-none data-disabled:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
    </ComboboxPrimitive.Item>
  )
}

export {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandSeparator,
  CommandItem,
}
