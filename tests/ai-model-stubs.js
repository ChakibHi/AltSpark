import { vi } from "vitest";

function normalizeAvailabilitySequence(input) {
  if (Array.isArray(input) && input.length > 0) {
    return input;
  }
  if (typeof input === "string") {
    return [{ status: input }];
  }
  if (input && typeof input === "object") {
    return [input];
  }
  return [{ status: "ready" }];
}

export function createModelCtor({
  availability = [{ status: "ready" }],
  createImplementation,
  defaultInstance = {},
} = {}) {
  const sequence = normalizeAvailabilitySequence(availability);
  let index = 0;

  const availabilityMock = vi.fn(async (...args) => {
    const result = index < sequence.length ? sequence[index] : sequence[sequence.length - 1];
    index += 1;
    return result;
  });

  const instances = [];

  const createMock = vi.fn(async (options = {}) => {
    const instance = typeof createImplementation === "function"
      ? await createImplementation(options, { availabilityCallCount: index })
      : { ...defaultInstance };
    instances.push({ options, instance });
    return instance;
  });

  const ctor = {
    availability: availabilityMock,
    create: createMock,
  };

  return { ctor, availabilityMock, createMock, instances };
}

export function createActivationError(message = "User activation is required") {
  const error = new Error(message);
  error.name = "ActivationRequiredError";
  return error;
}
