// Validates the JSON body against a Zod schema. On success, req.body is replaced by the
// cleaned result (trimmed, normalised, dates parsed), so handlers never see raw input.
const validate = (schema) => (req, res, next) => {
  // Express 5 leaves req.body undefined when a request has no body
  const result = schema.safeParse(req.body ?? {});

  if (!result.success) {
    return res.status(400).json({
      error: 'validation_error',
      message: result.error.issues[0].message,
      details: result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  req.body = result.data;
  next();
};

export default validate;