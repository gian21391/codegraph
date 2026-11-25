import type { ExtractionResult, Language } from '../../types';
import { matlabFileStem, matlabPathScope } from './matlab-path';
import { isJavaImport } from './matlab-java';
import { matlabUnreadReason } from './matlab-syntax';
import { MATLAB_BASE_NAMES, MATLAB_METHOD_NAMES } from './matlab-builtin-names';

/**
 * MATLAB built-in, GUI, graphics and common toolbox functions: every function
 * and class base MATLAB has (MATLAB_BASE_NAMES, generated from a MATLAB
 * install: see ./matlab-builtin-names; not a name MATLAB has only as a
 * method, MATLAB_METHOD_ONLY_NAMES below), and the names written here by
 * hand — toolboxes' functions, and MATLAB's own that it has since removed
 * (`wavread`, `nargchk`), which old code still calls. A bare call of
 * one of these names is extracted like any other call, and the resolver links
 * it when the project has a function of that name in reach (a `normpdf.m`
 * stand-in, a `private/strsplit.m` shim, a local function named `grid`): MATLAB
 * takes those before its own. A call of one that resolves to nothing is
 * deleted rather than kept as an unresolved reference (see
 * ../../resolution/matlab-failures), and one nothing in the project could
 * answer is never written at all (see MatlabInsertFilter). Drawn from the
 * names most often left unresolved across six real MATLAB code bases, a
 * 17k-file one among them
 * codebase (the hand-written names).
 *
 * A bare call goes by its name alone: `numel(obj)` on a method's own object
 * is `Cls::numel` (a class's overload), and so is `set(c, …)` on a variable
 * the function says holds a class, discarded only when no symbol carries the
 * name either. A handle to one (`@isempty`, `cellfun(@size, …)`) goes the
 * same way as its call. What a discard costs a later sync: see the top of
 * ../../resolution/matlab-failures.
 */
export const MATLAB_BUILTINS: ReadonlySet<string> = new Set([
  ...MATLAB_BASE_NAMES,
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
  'isjava', 'diary', 'echo', 'format', 'beep', 'sound', 'clc', 'clear', 'whos', 'who', 'pack', 'help', 'edit', 'open',
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
  // more of MATLAB: geometry, numerics, logic and bits
  'blkdiag', 'convhull', 'convhulln', 'delaunay', 'inpolygon', 'griddata', 'sphere', 'light', 'lightangle',
  'reducepatch', 'waterfall', 'sph2cart', 'cart2sph', 'cart2pol', 'pol2cart', 'logspace', 'atand', 'cosd', 'rad2deg',
  'gcd', 'lcm', 'magic', 'poly', 'toeplitz', 'schur', 'rsf2csf', 'sqrtm', 'svds', 'spalloc', 'speye', 'ipermute',
  'intmax', 'integral', 'ode45', 'pchip', 'unwrap', 'issorted', 'setxor', 'xor', 'and', 'eq', 'ne', 'bitget',
  'bitset', 'finite', 'isglobal', 'fmins', 'hypot', 'vander', 'logm', 'rat', 'not', 'or', 'sind', 'tand',
  'vecnorm', 'histcounts', 'digraph', 'trisurf', 'polar', 'daspect', 'xtickangle', 'frame2im', 'height',
  // tables, strings, files and the GUI
  'readtable', 'table2array', 'array2table', 'table2struct', 'struct2table', 'table2cell', 'setvartype',
  'extractAfter', 'extractBefore', 'strread', 'regexptranslate', 'fileread', 'xlswrite', 'xmlread', 'hdf5read',
  'hdf5write', 'h5read', 'h5readatt', 'memmapfile', 'unzip', 'urlwrite', 'websave', 'clipboard', 'uisave', 'movie',
  'ind2rgb', 'rgb2ind', 'gtext', 'uitoggletool', 'uitreenode', 'xticks', 'strlength', 'csvread', 'uifigure',
  'uiaxes', 'methodsview', 'what', 'functions', 'desktop', 'system_dependent',
  // objects, errors, timers and the Java, COM, C and Python bridges
  'findprop', 'ismethod', 'properties', 'handle', 'throw', 'message', 'addOptional', 'addParameter', 'stop',
  'awtinvoke', 'javachk', 'calllib', 'pyargs', 'invoke', 'hgfeval', 'feature', 'license', 'numnodes', 'start',
  'timerfind',
  // toolboxes: signal, optimization, statistics, image, control, instrument, database, OPC, deep learning, fuzzy
  // logic, Simulink, symbolic
  'zp2tf', 'tf2sos', 'freqz', 'sinc', 'findpeaks', 'envelope', 'bartlett', 'fmincon', 'fminunc', 'optimoptions',
  'lhsdesign', 'tabulate', 'random', 'nanmedian', 'getrect', 'imfill', 'imcontrast', 'mean2', 'tf', 'pzplot',
  'binblockread', 'icdevice', 'visa', 'exec', 'fetch', 'setdbprefs', 'opcda', 'fullyConnectedLayer', 'reluLayer',
  'featureInputLayer', 'dlnetwork', 'adamupdate', 'mapminmax', 'radbas', 'addMF', 'sim', 'matlabFunction',
  'pwelch', 'firpm', 'xcorr', 'psd', 'fit', 'gamrnd', 'unidrnd', 'pdf', 'strel', 'imdilate', 'std2', 'dicominfo',
  'heaviside', 'newrbe', 'instrhwinfo', 'get_param', 'load_system', 'close_system',
  // more of MATLAB, each one a name real code calls (not a demo or an example, not one class's method)
  'actxcontrol', 'actxGetRunningServer', 'actxserver', 'addlistener', 'addtodate', 'addToolbarExplorationButtons',
  'alim', 'alphamap', 'alphaShape', 'append', 'asinh', 'atan2d', 'atanh', 'audioinfo', 'audioplayer', 'audioread',
  'audiorecorder', 'audiowrite', 'autumn', 'awtcreate', 'axtoolbar', 'axtoolbarbtn', 'bandwidth', 'bar3', 'base2dec',
  'besselj', 'beta', 'betainc', 'bitcmp', 'bitxor', 'bone', 'boundary', 'brighten', 'bvp4c', 'bvp5c', 'bvpinit',
  'calendar', 'callstats', 'cameratoolbar', 'camorbit', 'campos', 'camtarget', 'categorical', 'cell2table',
  'checkcode', 'cholupdate', 'clabel', 'closereq', 'colordef', 'condest', 'contourf', 'convertStringsToChars', 'cot',
  'count', 'ctranspose', 'cylinder', 'daqread', 'days', 'dec2base', 'deg2rad', 'delaunayn', 'DelaunayTri',
  'delaunayTriangulation', 'detectImportOptions', 'dialog', 'discretize', 'dmperm', 'dsearchn', 'ellipke',
  'ellipsoid', 'endsWith', 'eomday', 'erase', 'erfcinv', 'erfinv', 'expm1', 'exportgraphics', 'ferror', 'fields',
  'fill3', 'filter2', 'flag', 'fminbnd', 'fzero', 'gather', 'ge', 'getArrayFromByteStream', 'getByteStreamFromArray',
  'graph', 'griddatan', 'groupcounts', 'gt', 'guidemfile', 'gunzip', 'gzip', 'h5info', 'hankel', 'helpwin',
  'hgconvertunits', 'hggroup', 'hgload', 'hgsave', 'hilb', 'histogram', 'hot', 'hours', 'hsv', 'hsv2rgb', 'ichol',
  'idivide', 'ifftshift', 'im2java', 'imfinfo', 'imresize', 'imshow', 'integral2', 'integral3', 'interp3', 'interpn',
  'iqr', 'iscategorical', 'iscom', 'isdatetime', 'isequalwithequalnans', 'isgraphics', 'ishermitian', 'isletter',
  'ismissing', 'isosurface', 'isprop', 'isstrprop', 'issymmetric', 'isvarname', 'java', 'javaArray', 'javacomponent',
  'javaObjectEDT', 'join', 'le', 'legendre', 'libisloaded', 'libpointer', 'lin2mu', 'lines', 'linkprop', 'linsolve',
  'listfonts', 'loadlibrary', 'log1p', 'lscov', 'lsqnonneg', 'lsqr', 'lt', 'lu', 'matfile', 'matlabpath', 'maxk',
  'membrane', 'memory', 'metaclass', 'methods', 'mink', 'minus', 'minute', 'mldivide', 'more', 'moviein', 'mtimes',
  'mu2lin', 'nargoutchk', 'native2unicode', 'newplot', 'nextpow2', 'nthroot', 'ode113', 'ode15s', 'ode23', 'odephas2',
  'odeplot', 'odeset', 'opengl', 'openvar', 'optimget', 'parfeval', 'parseparams', 'pcg', 'perms', 'pie', 'pink',
  'plus', 'polyshape', 'ppval', 'profview', 'publish', 'putdowntext', 'quad', 'quadgk', 'quiver', 'quiver3', 'rats',
  'rdivide', 'realmax', 'recycle', 'refreshdata', 'repelem', 'rescale', 'reset', 'resize', 'rgb2gray', 'rmpref',
  'rose', 'rref', 'savepath', 'sech', 'seconds', 'serial', 'serialport', 'showdemo', 'slice', 'soundsc', 'soundview',
  'spconvert', 'splitlines', 'spones', 'sprand', 'spring', 'spy', 'stem3', 'strings', 'strip', 'strjust', 'structfun',
  'subsasgn', 'subspace', 'subsref', 'superclasses', 'superiorto', 'surf2patch', 'surfc', 'surfl', 'symvar', 'table',
  'tcpclient', 'testsuite', 'textwrap', 'timerfindall', 'times', 'timeseries', 'triangulation', 'trimesh', 'triplot',
  'TriRep', 'tsearchn', 'type', 'uiclearmode', 'uiconfirm', 'uicontainer', 'uihyperlink', 'uiimage', 'uilistbox',
  'uiopen', 'uirestore', 'uislider', 'uistack', 'uistyle', 'uisuspend', 'uitab', 'uitabgroup', 'uitextarea',
  'uitoolbar', 'uminus', 'unicode2native', 'unmkpp', 'untar', 'validatestring', 'vectorize', 'VideoReader',
  'VideoWriter', 'width', 'winopen', 'winqueryreg', 'writetable', 'xlsfinfo', 'xmlwrite', 'xtickformat',
  'xticklabels', 'yticklabels', 'yticks', 'zip', 'zlim',
  // the same, from toolboxes: image processing, control, Simulink, statistics, mapping, symbolic
  'addterms', 'bdIsLoaded', 'bdroot', 'bode', 'bwareaopen', 'bwdist', 'bwdistgeodesic', 'bwfill', 'bwlabeln',
  'bwtraceboundary', 'conndef', 'connect', 'dataset', 'dicomread', 'fspecial', 'graythresh', 'histeq', 'im2bw',
  'im2col', 'imadjust', 'imclose', 'imcrop', 'imerode', 'imhist', 'imline', 'imopen', 'implay', 'impulse', 'imrect',
  'KDTreeSearcher', 'makedist', 'maketform', 'minreal', 'new_system', 'pzmap',
  'regionprops', 'roundn', 'series', 'simsizes', 'ss2tf', 'str2sym', 'tf2ss', 'tf2zp', 'tformfwd',
  'tforminv', 'tiedrank', 'wiener2', 'zp2ss',
]);

/**
 * The names base MATLAB has only as a method of one of its own classes
 * (MATLAB_METHOD_NAMES: `parse` of `inputParser`, `keys` of `containers.Map`,
 * `numedges` of `graph`), and that no hand-written name above makes a
 * built-in. No built-ins: MATLAB has no function of the name, so a project's
 * copy is reached as any function is, and nothing here treats a call of one
 * as MATLAB's. One rule alone reads it: a bare call of one that no symbol
 * carries the name of is kept dormant rather than live, as the only code of
 * the name MATLAB has is its class's method (see
 * ../../resolution/matlab-failures).
 */
export const MATLAB_METHOD_ONLY_NAMES: ReadonlySet<string> = new Set(MATLAB_METHOD_NAMES.filter((n) => !MATLAB_BUILTINS.has(n)));

/**
 * Whether a callee written `name` may be an old-style class's constructor,
 * when no variable holds the name (`g = gadget();`, `@gadget/gadget.m`): a
 * lower-case name that is none of MATLAB's (no built-in's, none MATLAB has
 * only as a method). What a call on the object it makes may dispatch to is
 * the resolver's to tell (see the argClass fact in ./matlab-ref-facts).
 */
export function isMatlabLowerConstructorName(name: string): boolean {
  return /^[a-z]/.test(name) && !MATLAB_BUILTINS.has(name) && !MATLAB_METHOD_ONLY_NAMES.has(name);
}

/**
 * MATLAB functions whose first argument may name a function as text
 * (`cellfun('myfun', c)`, `fzero('fbase', x0)`, `ode45('rhs', …)`): that
 * text references the function. Not the deprecated `quad`, `quadl` and
 * `quadv`, a name projects reuse for their own functions (an accelerator
 * lattice's `quad('QF', 0.34, …)` makes a quadrupole, and names no function).
 */
export const MATLAB_FUNCTION_TAKERS: ReadonlySet<string> = new Set([
  'cellfun', 'arrayfun', 'structfun', 'fzero', 'fminsearch', 'fminbnd', 'fminunc', 'fmincon', 'fsolve', 'lsqnonlin',
  'lsqcurvefit', 'quadgk', 'integral', 'integral2', 'integral3', 'ode23', 'ode45', 'ode113', 'ode15s', 'ode15i',
  'ode23s', 'ode23t', 'ode23tb',
]);

/**
 * `cellfun`'s own names for its legacy fast paths (`cellfun('isempty', c)`):
 * MATLAB's, never a function of the project's.
 */
export const MATLAB_CELLFUN_NAMES: ReadonlySet<string> = new Set([
  'isempty', 'islogical', 'isreal', 'length', 'ndims', 'prodofsize', 'size', 'isclass',
]);

/**
 * MATLAB's constructors and setters of graphics objects, GUI components and
 * timers, whose name/value arguments may give a callback as code
 * (`uicontrol('Callback', 'dialpane(''ViewGain'')')`, `set(h, 'KeyPressFcn',
 * 'onkey')`), and `struct`, which GUI code builds callback tables with. Only
 * these: any other function given `'Callback', 'go'` (a project's own
 * `myfun('Callback', 'go')`, `strrep(s, 'Callback', …)`) takes text, as far
 * as anything here can tell.
 */
export const MATLAB_CALLBACK_OWNERS: ReadonlySet<string> = new Set([
  'uicontrol', 'uimenu', 'uicontextmenu', 'uipushtool', 'uitoggletool', 'uitoolbar', 'uipanel', 'uibuttongroup',
  'uitable', 'uitab', 'uitabgroup', 'figure', 'axes', 'set', 'line', 'patch', 'surface', 'image', 'text',
  'rectangle', 'timer', 'struct', 'uifigure', 'uiaxes', 'uibutton', 'uidropdown', 'uieditfield', 'uislider',
  'uicheckbox',
]);

/**
 * MATLAB functions that may run project code other than through an object
 * handed to them: what they are given to call or evaluate (`feval`,
 * `cellfun`, `eval`), a callback (a GUI constructor's `CreateFcn`, `set`,
 * `delete`'s `DeleteFcn`), or events waiting to be handled (`drawnow`,
 * `pause`, `waitfor`). Not `struct`: a table of callbacks it builds runs
 * nothing until something is given it.
 */
export const MATLAB_CODE_RUNNERS: ReadonlySet<string> = new Set([
  ...MATLAB_FUNCTION_TAKERS, ...[...MATLAB_CALLBACK_OWNERS].filter((n) => n !== 'struct'),
  'feval', 'eval', 'evalc', 'evalin', 'assignin', 'run', 'builtin', 'str2func', 'drawnow', 'pause', 'waitfor',
  'uiwait', 'notify', 'delete', 'close', 'start', 'stop', 'refresh', 'input', 'keyboard', 'quad', 'quadl', 'quadv',
  'quadgk', 'ode45', 'hgfeval', 'listener', 'addlistener',
]);

/** Whether a reference kind names a bare name the way a call does: a call (`plot(x)`) or a handle (`@plot`). */
export function callsByName(kind: string): boolean {
  return kind === 'calls' || kind === 'function_ref';
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
    const stem = matlabFileStem(p);
    if (!stem) continue;
    const scope = matlabPathScope(p);
    if (scope.packages.length === 0) into.add(scope.classFolder ?? stem);
  }
}

/**
 * `refs` of a MATLAB file without its bare built-in calls (and handles to
 * built-ins, `@isempty`) that nothing in the project could answer: no
 * function or class of the file itself (`defined`, the file's nodes) and no
 * `.m` file of that name (`reachable`). A file that imports anything keeps
 * them all, as an import reaches a package's functions and a class's methods
 * by a bare name (one of Java's, `import java.util.*`, reaches none). `refs`
 * itself when nothing goes.
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
    if (callsByName(ref.referenceKind) && MATLAB_BUILTINS.has(name) && !reachable.has(name)) {
      if (!own) {
        if (defined.some((n) => n.kind === 'import' && !isJavaImport(n.name))) return refs;
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

/**
 * The extraction-side half of the built-in discard: a run's MATLAB results
 * without the built-in calls nothing in the project could answer
 * (withoutUnanswerableMatlabBuiltins), so that their rows are never written.
 * The resolver deletes them anyway when they fail, but written and deleted
 * they slow a large MATLAB codebase's full index and leave its database file
 * much larger: the pages they took are not given back.
 *
 * What a bare call can reach outside its file is read once: the names of the
 * `.m` files already stored, read at the first MATLAB file a run stores (or
 * by `loadStored`), and of every file a run is about to store (`expect`),
 * which a file it stores before them may call. It grows, and is read again
 * after a sync removes a `.m` file (`forget`), or stores one named for a
 * built-in whose text answers no call now (see `expect`), so a name no file
 * answers for any more keeps no call a fresh index would drop.
 */
export class MatlabInsertFilter {
  private reachable: Set<string> | null = null;
  private expected: string[] = [];
  /**
   * The `.m` files named for a built-in that a run expects with Octave or
   * binary text: the index may still hold one's earlier text (it is stored
   * later in the run), which answered calls of its name.
   */
  private readonly silent = new Set<string>();

  /**
   * `storedPaths` lists the paths of the MATLAB files the index holds whose
   * text is MATLAB code (no Octave or binary file's: see matlabUnreadReason);
   * `readSource` reads a project file's text, or gives null.
   */
  constructor(
    private readonly storedPaths: () => Iterable<string>,
    private readonly readSource: (filePath: string) => string | null,
  ) {}

  /**
   * Files a run will store. A path here has no language yet (an Objective-C
   * `.m` reads as MATLAB only from its content), so every `.m` path's name is
   * taken: it keeps a built-in's call of that name a row until resolution
   * discards it, never an edge. But for a file named for a built-in, which is
   * read now (there are few): one of Octave or binary text answers no call
   * (Octave's `datestr.m`, MATLAB Compiler's encrypted `pause.m`), and the
   * resolver would discard the rows its name kept. When such a file's
   * earlier text answered calls (an empty `disp.m` a long-lived process
   * indexed, turned to Octave since), the names are read again without it,
   * as a fresh index of the files reads them: a later file's `@disp` keeps
   * no row, which the resolver would keep failed while a class's method
   * `disp` carries the name.
   */
  expect(paths: readonly string[]): void {
    const answering: string[] = [];
    for (const p of paths) {
      if (!p.toLowerCase().endsWith('.m')) continue;
      if (!this.answersNoCall(p)) {
        this.silent.delete(p);
        answering.push(p);
      } else if (!this.silent.has(p)) {
        this.silent.add(p);
        this.reachable = null;
      }
    }
    if (this.reachable) addMatlabReachableNames(answering, this.reachable);
    else this.expected.push(...answering);
  }

  /** Whether `p`, a `.m` file named for a built-in, holds Octave or binary text. */
  private answersNoCall(p: string): boolean {
    const named = new Set<string>();
    addMatlabReachableNames([p], named);
    if (![...named].some((n) => MATLAB_BUILTINS.has(n))) return false;
    const source = this.readSource(p);
    return source !== null && matlabUnreadReason(source) !== null;
  }

  /** Drops the names read so far: the next filter reads the stored files' again (a sync that removed a `.m` file). */
  forget(): void {
    this.reachable = null;
  }

  /**
   * Read the stored files' names now, when a run expects MATLAB files: a full
   * index calls this before its parse loop, in which the main thread must not
   * read the database.
   */
  loadStored(): void {
    if (this.expected.length > 0) this.names();
  }

  /** Whether a bare call of `name` reaches a `.m` file outside its own file (see addMatlabReachableNames): one the filter keeps. */
  reaches(name: string): boolean {
    return this.names().has(name);
  }

  /** `result` without the built-in calls nothing in the project could answer; `result` itself for any other language. */
  filter(result: ExtractionResult, filePath: string, language: Language): ExtractionResult {
    if (language !== 'matlab' || result.unresolvedReferences.length === 0) return result;
    const reachable = this.names();
    addMatlabReachableNames([filePath], reachable);
    const refs = withoutUnanswerableMatlabBuiltins(result.unresolvedReferences, result.nodes, reachable);
    return refs === result.unresolvedReferences ? result : { ...result, unresolvedReferences: refs };
  }

  private names(): Set<string> {
    if (!this.reachable) {
      this.reachable = new Set();
      const stored = [...this.storedPaths()];
      addMatlabReachableNames(this.silent.size === 0 ? stored : stored.filter((p) => !this.silent.has(p)), this.reachable);
      addMatlabReachableNames(this.expected, this.reachable);
      this.expected = [];
    }
    return this.reachable;
  }
}

/**
 * MATLAB's functions that error on an object whose class defines no method
 * of the name (measured in MATLAB R2026a on a classdef with no methods and
 * on an old-style class; `~=`, `kron`, `sort`, `unique` by the same check;
 * `<=`, `>` and `>=`, `le`, `gt`, `ge`, by the same check, step 15 round 7b):
 * a write `v = f(…, v, …)` through one of them either runs the class's own
 * `f` (which, by the project rule, gives the object back) or stops there, so
 * no path through it reaches a later call with anything but the object (see
 * keepsObject in ./matlab). `&&` and `||` error the same way (keepsObject reads them).
 */
export const ERRORING_ON_OBJECTS: ReadonlySet<string> = new Set([
  'and', 'or', 'not', 'eq', 'ne', 'lt', 'le', 'gt', 'ge', 'plus', 'uminus', 'kron', 'sort', 'unique', 'sum', 'abs', 'max',
  'any', 'all', 'isnan', 'double', 'num2str', 'mat2str', 'ismember',
]);

/**
 * MATLAB's functions that give a value of another class for an object whose
 * class defines no method of the name (measured in MATLAB R2026a): a write
 * through one of them keeps the object only when the class has such a
 * method (the `keptBy` fact). So does any MATLAB function not measured
 * (see keepsObject). Of the method's own object, these alone end the hint
 * among MATLAB's functions (see ownWriteKind).
 */
export const VALUE_RETURNING_ON_OBJECTS: ReadonlySet<string> = new Set([
  'numel', 'size', 'isempty', 'length', 'class', 'isequal', 'ndims', 'isa', 'isstruct', 'struct', 'fieldnames', 'isfield',
  'isobject',
]);

/**
 * MATLAB's functions whose value is the object they are given: when a class
 * overloads them, an old-style class's `set` (doc 'set', the class's own
 * returns the object it changes), `subsasgn`, and the arithmetic operators'
 * functions (doc 'Implementing Operators for Your Class'); and, for any
 * class, overloaded or not, the built-ins that rearrange an array (measured
 * in MATLAB R2026a on a classdef with no methods and on an old-style class:
 * each gives an array of the object's class). See keepsObject in ./matlab.
 */
export const OBJECT_RETURNING_BUILTINS: ReadonlySet<string> = new Set([
  'set', 'subsasgn', 'plus', 'minus', 'uminus', 'uplus', 'times', 'mtimes', 'rdivide', 'ldivide', 'mrdivide', 'mldivide',
  'power', 'mpower', 'transpose', 'ctranspose',
  'reshape', 'repmat', 'permute', 'ipermute', 'cat', 'horzcat', 'vertcat', 'circshift', 'flip', 'fliplr', 'flipud', 'rot90',
  'squeeze', 'shiftdim', 'repelem', 'resize',
]);

/**
 * Whether a `keptBy` fact may name `name` (see ../../resolution/matlab-sync's
 * reopenMatlabKeptByCalls): one of MATLAB's names that neither keeps an object
 * unconditionally nor errors on one.
 */
export function isMatlabKeptByName(name: string): boolean {
  return MATLAB_BUILTINS.has(name) && !OBJECT_RETURNING_BUILTINS.has(name) && !ERRORING_ON_OBJECTS.has(name);
}
