'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');
const service = require('../services/workspace.service');
const router  = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_FAILED', fields: errors.array() });
  next();
}

// POST /workspace/create
router.post('/create', [
  body('workspaceName').isString().trim().isLength({ min: 3, max: 100 }),
  body('projectTitle').isString().trim().isLength({ min: 3, max: 100 }),
  body('projectDescription').isString().trim().isLength({ min: 10, max: 1000 }),
  body('srsDocument').isString().trim().notEmpty(),
  body('githubRepoUrl').isString().trim()
    .matches(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  body('githubRepoId').isInt({ min: 1 }).withMessage('githubRepoId must be a positive integer'),
  body('githubUsers').isArray({ min: 1, max: 20 }),
  body('githubUsers.*').isString().trim().notEmpty().matches(/^\S+$/),
], validate, async (req, res, next) => {
  try {
    const dedupedUsers = [...new Set(req.body.githubUsers.map(u => u.trim().toLowerCase()))];
    const result = await service.createWorkspace({ ...req.body, githubUsers: dedupedUsers });
    return res.status(201).json(result);
  } catch (err) { next(err); }
});

// POST /workspace/join
router.post('/join', [
  body('userUid').isString().trim().isUUID(4),
], validate, async (req, res, next) => {
  try {
    const result = await service.joinWorkspace(req.body.userUid.trim());
    return res.status(200).json(result);
  } catch (err) { next(err); }
});

// POST /workspace/dashboard
router.post('/dashboard', [
  body('dashboardAccessKey').isString().trim().isUUID(4),
], validate, async (req, res, next) => {
  try {
    const result = await service.getDashboard(req.body.dashboardAccessKey.trim());
    return res.status(200).json(result);
  } catch (err) { next(err); }
});

module.exports = router;
