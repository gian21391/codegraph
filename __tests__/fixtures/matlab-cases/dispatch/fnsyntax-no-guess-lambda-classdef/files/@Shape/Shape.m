classdef Shape < handle
    methods
        function obj = Shape(L)
            render(L);
        end
        function onClick(obj, src, evt)
            render(src);
        end
    end
end
