const errorBody = (error) => ({
  error: 'validation_error',
  message: error.issues[0].message,
  details: error.issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message,
  })),
});

// Validates the JSON body against a Zod schema. On success, req.body is replaced by the
// cleaned result (trimmed, normalised, dates parsed), so handlers never see raw input.
const validate = (schema) => (req, res, next) => {
  // Express 5 leaves req.body undefined when a request has no body
  const result = schema.safeParse(req.body ?? {});
  if (!result.success) return res.status(400).json(errorBody(result.error));

  req.body = result.data;
  next();
};

// Same for the query string. In Express 5 req.query is read-only, so the cleaned values
// go to res.locals.query instead.
export const validateQuery = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.query);
  if (!result.success) return res.status(400).json(errorBody(result.error));

  res.locals.query = result.data;
  next();
};

export default validate;