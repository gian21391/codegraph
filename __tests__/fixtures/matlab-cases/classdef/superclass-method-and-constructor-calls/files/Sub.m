classdef Sub < Base & pkg.Other
    methods
        function obj = Sub(varargin)
            obj = obj@Base(varargin{:});
            obj = obj@pkg.Other();
        end
        function delete(obj)
            delete@Base(obj);
            show@pkg.Other(obj, 1);
        end
    end
end
