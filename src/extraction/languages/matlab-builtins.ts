import { matlabPathScope } from './matlab-path';

/**
 * MATLAB built-in, GUI, graphics and common toolbox functions. A bare call of
 * one of these names is extracted like any other call, and the resolver links
 * it when the project has a function of that name in reach (a `normpdf.m`
 * stand-in, a `private/strsplit.m` shim, a local function named `grid`): MATLAB
 * takes those before its own. Only a call of one that resolves to nothing is
 * discarded rather than kept as an unresolved reference: each would stay one
 * in every function that uses it, and on a large MATLAB codebase those are
 * most of the database. Drawn from the names most often left unresolved
 * across PlatEMO, the Robotics Toolbox, fieldtrip, DeepLearnToolbox, PRMLT and
 * a 17k-file accelerator-physics codebase.
 *
 * Only a bare call is ever discarded: `numel(obj)` on a method's own object is
 * `Cls::numel` (a class's overload), and so is `set(c, …)` on a variable the
 * function says holds a class; `@size` is a function reference.
 *
 * What is discarded is gone for good: a sync that later adds `normpdf.m` links
 * the calls in the files it re-indexes, but not those in files it leaves alone,
 * which a full re-index does (pinned in __tests__/matlab-resolution.test.ts).
 */
export const MATLAB_BUILTINS: ReadonlySet<string> = new Set([
  // constants and argument counts
  'pi', 'true', 'false', 'Inf', 'inf', 'NaN', 'nan', 'eps', 'nargin', 'nargout',
  // array construction and shape
  'size', 'length', 'numel', 'isscalar', 'zeros', 'ones', 'eye', 'rand', 'randn', 'randi', 'randperm', 'repmat',
  'reshape', 'cat', 'linspace', 'meshgrid', 'cell', 'struct', 'deal', 'transpose', 'fliplr', 'diag', 'full',
  'sparse', 'cell2mat',
  // arithmetic, reductions and sets
  'sum', 'prod', 'cumsum', 'cumprod', 'mean', 'std', 'max', 'min', 'abs', 'sqrt', 'exp', 'log', 'sin', 'cos',
  'acos', 'asin', 'atan', 'real', 'imag', 'conj', 'floor', 'ceil', 'round', 'mod', 'rem', 'sign', 'norm',
  'sort', 'sortrows', 'unique', 'setdiff', 'intersect', 'ismember', 'any', 'all', 'find',
  // predicates and conversion
  'isempty', 'isfield', 'isnumeric', 'ischar', 'iscell', 'isstruct', 'isnan', 'isinf', 'isa', 'isequal',
  'strcmp', 'strcmpi', 'num2str', 'sprintf', 'double', 'logical', 'fieldnames', 'func2str', 'feval', 'cellfun',
  'arrayfun', 'fullfile', 'fileparts', 'mfilename', 'exist',
  // output and errors
  'disp', 'fprintf', 'error', 'warning', 'assert', 'rethrow',
  // graphics: plots, axes, figures, handles
  'set', 'get', 'plot', 'subplot', 'xlabel', 'ylabel', 'zlabel', 'figure', 'axis', 'title', 'hold', 'grid',
  'gca', 'gcf', 'gco', 'gcbf', 'gcbo', 'drawnow', 'legend', 'clf', 'cla', 'axes', 'semilogy', 'semilogx',
  'loglog', 'bar', 'barh', 'text', 'line', 'patch', 'plotyy', 'xlim', 'ylim', 'colormap', 'colorbar', 'caxis',
  'imagesc', 'image', 'surf', 'surface', 'mesh', 'shading', 'view', 'plot3', 'errorbar', 'stairs', 'stem',
  'hist', 'histc', 'fill', 'rectangle', 'annotation', 'copyobj', 'findobj', 'findall', 'allchild', 'ancestor',
  'ishandle', 'ishghandle', 'linkaxes', 'datetick', 'camlight', 'lighting', 'material', 'zoom', 'pan',
  'rotate3d', 'datacursormode', 'rbbox', 'ginput', 'getframe', 'print', 'saveas', 'orient', 'close', 'shg',
  'box', 'alpha', 'contour', 'pcolor', 'scatter', 'scatter3', 'gray', 'jet', 'yyaxis', 'ishold', 'hgtransform',
  'texlabel', 'viewmtx', 'area', 'printpreview',
  // GUI: uicontrols, dialogs, GUIDE and app data
  'uicontrol', 'uimenu', 'uicontextmenu', 'uipanel', 'uibuttongroup', 'uitable', 'uibutton', 'uilabel',
  'uieditfield', 'uidropdown', 'uicheckbox', 'uigridlayout', 'uialert', 'uiwait', 'uiresume', 'uigetfile',
  'uiputfile', 'uigetdir', 'uisetcolor', 'questdlg', 'inputdlg', 'errordlg', 'warndlg', 'msgbox', 'listdlg',
  'helpdlg', 'waitbar', 'waitfor', 'menu', 'guidata', 'guihandles', 'getappdata', 'setappdata', 'isappdata',
  'rmappdata', 'openfig', 'movegui', 'getpixelposition', 'setpref', 'getpref', 'ispref', 'gui_mainfcn', 'timer',
  // strings and character conversion
  'cellstr', 'lower', 'upper', 'strcat', 'deblank', 'strtrim', 'strfind', 'findstr', 'strrep', 'strtok',
  'strvcat', 'strmatch', 'strncmp', 'strncmpi', 'strjoin', 'strsplit', 'regexp', 'regexpi', 'regexprep',
  'sscanf', 'int2str', 'mat2str', 'str2num', 'str2mat', 'isstr', 'setstr', 'blanks', 'isspace', 'iscellstr',
  'dec2bin', 'bin2dec', 'hex2dec', 'dec2hex', 'string', 'textscan', 'textread', 'genvarname',
  // files, I/O, paths, environment and the session
  'fread', 'fwrite', 'fclose', 'fscanf', 'fgetl', 'fgets', 'fseek', 'ftell', 'feof', 'frewind', 'load', 'save',
  'dlmread', 'dlmwrite', 'csvwrite', 'xlsread', 'importdata', 'dir', 'ls', 'mkdir', 'rmdir', 'movefile',
  'copyfile', 'delete', 'cd', 'pwd', 'addpath', 'rmpath', 'genpath', 'path', 'which', 'tempname', 'tempdir',
  'filesep', 'pathsep', 'fileattrib', 'imread', 'imwrite', 'wavread', 'urlread', 'sendmail', 'computer', 'ispc',
  'isunix', 'ismac', 'getenv', 'setenv', 'system', 'unix', 'dos', 'matlabroot', 'version', 'ver', 'verLessThan',
  'isdeployed', 'mexext', 'mex', 'javaaddpath', 'javaclasspath', 'javaObject', 'javaMethod', 'usejava',
  'isjava', 'diary', 'echo', 'format', 'beep', 'clc', 'clear', 'whos', 'who', 'pack', 'help', 'edit', 'open',
  'keyboard', 'inputname', 'assignin', 'evalin', 'evalc', 'eval', 'builtin', 'dbstack', 'lasterr', 'lasterror',
  'lastwarn', 'MException', 'getReport', 'onCleanup', 'inputParser', 'nargchk', 'exit', 'isdir', 'instrfind',
  'tcpip', 'jsondecode', 'jsonencode', 'web', 'profile',
  // time
  'clock', 'date', 'etime', 'tic', 'toc', 'cputime',
  // more numerics, types, cells and structs
  'interp1', 'interp2', 'inv', 'diff', 'fix', 'svd', 'fft', 'ifft', 'fftshift', 'log10', 'log2', 'isfinite',
  'isreal', 'polyval', 'polyfit', 'tan', 'tanh', 'atan2', 'cosh', 'sinh', 'acosh', 'det', 'kron', 'trace',
  'pinv', 'rank', 'null', 'orth', 'eig', 'eigs', 'chol', 'qr', 'expm', 'squeeze', 'permute', 'ndims',
  'shiftdim', 'circshift', 'flipud', 'flipdim', 'rot90', 'triu', 'tril', 'sub2ind', 'ind2sub', 'nnz',
  'nonzeros', 'trapz', 'conv', 'conv2', 'convn', 'detrend', 'median', 'var', 'cov', 'corrcoef', 'power',
  'complex', 'angle', 'gamma', 'gammaln', 'erf', 'factorial', 'nchoosek', 'roots', 'fminsearch', 'accumarray',
  'bsxfun', 'cross', 'dot', 'vertcat', 'horzcat', 'cast', 'typecast', 'single', 'int8', 'int16', 'int32',
  'int64', 'uint8', 'uint16', 'uint32', 'uint64', 'bitand', 'bitor', 'bitshift', 'swapbytes', 'psi', 'besseli',
  'spline', 'spdiags', 'i', 'j', 'islogical', 'isvector', 'issparse', 'isobject', 'isvalid', 'isfloat',
  'isinteger', 'num2cell', 'mat2cell', 'struct2cell', 'cell2struct', 'rmfield', 'setfield', 'getfield',
  'orderfields', 'substruct', 'str2func', 'inline', 'display', 'union', 'cond', 'rcond', 'gradient', 'filter',
  // toolboxes: statistics, signal, image, symbolic, Simulink, control, unit tests, deep learning
  'normcdf', 'normpdf', 'normrnd', 'unifrnd', 'randsample', 'datasample', 'prctile', 'rng', 'RandStream', 'sym',
  'syms', 'add_line', 'add_block', 'find_system', 'open_system', 'bdclose', 'save_system', 'delete_block',
  'verifyEqual', 'verifyTrue', 'verifyFalse', 'verifyError', 'functiontests', 'localfunctions', 'dlarray',
  'dlgradient', 'dlfeval', 'extractdata', 'lsim', 'subs',
  // names a project also defines (a compat shim, a deployed toolbox's copy): its calls link to that
  'char', 'class', 'pause', 'input', 'fopen', 'str2double', 'datestr', 'datenum', 'datevec', 'now', 'weekday',
  'datetime', 'contains', 'split', 'isstring', 'isrow', 'iscolumn', 'ismatrix', 'flip', 'narginchk', 'optimset',
  'mode', 'refresh', 'printdlg', 'savefig', 'ndgrid', 'normalize', 'rotate', 'run', 'webread', 'webwrite',
  'weboptions', 'writematrix', 'pdist2', 'kmeans', 'knnsearch', 'corr', 'anova', 'zscore', 'pca', 'ttest',
  'ttest2', 'mvnrnd', 'hanning', 'filtfilt', 'fir1', 'butter', 'flattopwin', 'resample', 'hilbert', 'set_param',
  'step', 'lyap', 'jacobian',
]);

/** Whether `ref` is a bare MATLAB call of a built-in's name (`plot(x)`, not `Cls::plot`, `obj.plot` or `@plot`). */
export function isMatlabBuiltinCall(ref: { referenceName: string; referenceKind: string; language?: string }): boolean {
  return ref.language === 'matlab' && ref.referenceKind === 'calls' && MATLAB_BUILTINS.has(ref.referenceName);
}

/**
 * Adds to `into` the names a bare MATLAB call can reach outside its own file
 * without an import, from the paths of a project's `.m` files: a function file
 * or a class is called by its file name, a class-folder class by its folder's
 * (see ../../resolution/matlab-lookup). Not a package's (`+pkg/f.m`), reached
 * by a bare name only through an import, nor a class folder's method files
 * (`@Cls/plot.m`), reached only through an object of the class, which the
 * extractor writes `Cls::plot`. Any other path is passed over.
 */
export function addMatlabReachableNames(paths: Iterable<string>, into: Set<string>): void {
  for (const p of paths) {
    if (!p.endsWith('.m')) continue;
    const m = /(?:^|[\\/])([A-Za-z][A-Za-z0-9_]*)\.m$/.exec(p);
    if (!m) continue;
    const scope = matlabPathScope(p);
    if (scope.packages.length === 0) into.add(scope.classFolder ?? m[1]!);
  }
}

/**
 * `refs` of a MATLAB file without its bare built-in calls that nothing in the
 * project could answer — no function or class of the file itself (`defined`,
 * the file's nodes) and no `.m` file of that name (`reachable`) — so that they
 * are never written at all. A file that imports anything keeps them all: an
 * import reaches a package's functions and a class's methods by a bare name.
 * The resolver discards the other ones that resolve to nothing
 * (`isMatlabBuiltinCall`); this spares the database their rows. `refs` itself
 * when nothing goes.
 */
export function withoutUnanswerableMatlabBuiltins<R extends { referenceName: string; referenceKind: string }>(
  refs: R[],
  defined: readonly { name: string; kind: string }[],
  reachable: ReadonlySet<string>,
): R[] {
  let own: Set<string> | null = null;
  let out: R[] | null = null;
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i]!;
    const name = ref.referenceName;
    if (ref.referenceKind === 'calls' && MATLAB_BUILTINS.has(name) && !reachable.has(name)) {
      if (!own) {
        if (defined.some((n) => n.kind === 'import')) return refs;
        own = new Set(defined.map((n) => n.name));
      }
      if (!own.has(name)) {
        out ??= refs.slice(0, i);
        continue;
      }
    }
    out?.push(ref);
  }
  return out ?? refs;
}
